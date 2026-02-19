import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const baseCorsHeaders = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

type RateLimitResult = {
  allowed: boolean;
  retry_after_seconds: number | null;
};

const TRACKED_STATUSES = new Set(["damaged", "lost", "in_repair", "retired", "in_studio_only"]);
const ALLOWED_GEAR_STATUSES = new Set([
  "available",
  "checked_out",
  "damaged",
  "lost",
  "in_repair",
  "retired",
  "in_studio_only",
]);

const DEFAULT_DUE_HOURS = 72;
const DEFAULT_ESC_1 = 120;
const DEFAULT_ESC_2 = 168;
const DEFAULT_ESC_3 = 240;

type RpcError = {
  code?: string;
  message?: string;
};

const isMissingRelation = (error: RpcError | null | undefined, relation: string) =>
  !!error &&
  error.code === "42P01" &&
  (error.message ?? "").toLowerCase().includes(relation.toLowerCase());

const isMissingColumn = (error: RpcError | null | undefined, column: string) =>
  !!error &&
  error.code === "42703" &&
  (error.message ?? "").toLowerCase().includes(column.toLowerCase());

const resolveCorsHeaders = (req: Request) => {
  const origin = req.headers.get("Origin");
  const allowedOrigins = (Deno.env.get("ITX_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const hasOrigin = !!origin;
  const originAllowed =
    !hasOrigin || (hasOrigin && allowedOrigins.includes(origin as string));

  const headers =
    hasOrigin && originAllowed
      ? { ...baseCorsHeaders, "Access-Control-Allow-Origin": origin as string }
      : { ...baseCorsHeaders };

  return { hasOrigin, originAllowed, headers };
};

const resolveMaintenance = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return { enabled: false, message: "" };
  }
  const payload = value as Record<string, unknown>;
  return {
    enabled: payload.enabled === true,
    message:
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "Maintenance in progress.",
  };
};

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const normalizeEscalationPolicy = (
  dueHours: number,
  level1: number,
  level2: number,
  level3: number
) => {
  const normalizedDue = parsePositiveInt(dueHours, DEFAULT_DUE_HOURS);
  const normalizedLevel1 = Math.max(parsePositiveInt(level1, DEFAULT_ESC_1), normalizedDue);
  const normalizedLevel2 = Math.max(parsePositiveInt(level2, DEFAULT_ESC_2), normalizedLevel1 + 1);
  const normalizedLevel3 = Math.max(parsePositiveInt(level3, DEFAULT_ESC_3), normalizedLevel2 + 1);
  return {
    due_hours: normalizedDue,
    escalation_level_1_hours: normalizedLevel1,
    escalation_level_2_hours: normalizedLevel2,
    escalation_level_3_hours: normalizedLevel3,
  };
};

const sendReminderEmail = async (
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string
) => {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Unable to send email.");
  }
};

serve(async (req) => {
  const { hasOrigin, originAllowed, headers } = resolveCorsHeaders(req);

  const jsonResponse = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    if (!originAllowed) {
      return new Response("Origin not allowed", { status: 403, headers });
    }
    return new Response("ok", { headers });
  }

  if (hasOrigin && !originAllowed) {
    return jsonResponse(403, { error: "Origin not allowed" });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const supabaseUrl = Deno.env.get("ITX_SUPABASE_URL");
    const publishableKey = Deno.env.get("ITX_PUBLISHABLE_KEY");
    const serviceKey = Deno.env.get("ITX_SECRET_KEY");

    if (!supabaseUrl || !publishableKey || !serviceKey) {
      return jsonResponse(500, { error: "Server misconfiguration" });
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("tenant_id, role")
      .eq("id", user.id)
      .single();

    if (profileError || !profile?.tenant_id) {
      return jsonResponse(403, { error: "Access denied" });
    }

    if (profile.role !== "tenant_admin" && profile.role !== "tenant_user") {
      return jsonResponse(403, { error: "Access denied" });
    }

    const { data: rateLimit, error: rateLimitError } = await userClient.rpc(
      "consume_rate_limit",
      {
        p_scope: profile.role === "tenant_admin" ? "admin" : "tenant",
        p_limit: profile.role === "tenant_admin" ? 30 : 25,
        p_window_seconds: 60,
      }
    );

    if (rateLimitError) {
      return jsonResponse(500, { error: "Rate limit check failed" });
    }

    const rateLimitResult = rateLimit as RateLimitResult;
    if (!rateLimitResult.allowed) {
      return jsonResponse(429, {
        error: "Rate limit exceeded, please try again in a minute.",
      });
    }

    const { action, payload } = await req.json();
    if (typeof action !== "string") {
      return jsonResponse(400, { error: "Invalid request" });
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const tenantId = profile.tenant_id as string;

    const duePolicySelect =
      "checkout_due_hours, escalation_level_1_hours, escalation_level_2_hours, escalation_level_3_hours";

    const loadPolicy = async () => {
      const duePolicyResult = await adminClient
        .from("tenant_policies")
        .select(duePolicySelect)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (
        duePolicyResult.error &&
        (isMissingColumn(duePolicyResult.error as RpcError, "escalation_level_1_hours") ||
          isMissingColumn(duePolicyResult.error as RpcError, "escalation_level_2_hours") ||
          isMissingColumn(duePolicyResult.error as RpcError, "escalation_level_3_hours"))
      ) {
        const fallback = await adminClient
          .from("tenant_policies")
          .select("checkout_due_hours")
          .eq("tenant_id", tenantId)
          .maybeSingle();
        const dueHours = parsePositiveInt(
          fallback.data?.checkout_due_hours,
          DEFAULT_DUE_HOURS
        );
        return normalizeEscalationPolicy(dueHours, DEFAULT_ESC_1, DEFAULT_ESC_2, DEFAULT_ESC_3);
      }

      const normalized = normalizeEscalationPolicy(
        duePolicyResult.data?.checkout_due_hours,
        duePolicyResult.data?.escalation_level_1_hours,
        duePolicyResult.data?.escalation_level_2_hours,
        duePolicyResult.data?.escalation_level_3_hours
      );
      return normalized;
    };

    const { data: maintenanceRow } = await adminClient
      .from("app_runtime_config")
      .select("value")
      .eq("key", "maintenance_mode")
      .maybeSingle();
    const maintenance = resolveMaintenance(maintenanceRow?.value);

    if (action === "get_notifications") {
      const [overdueCountResult, statusCountResult, recentStatusResult, policy] =
        await Promise.all([
          adminClient
            .from("gear")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .eq("status", "checked_out")
            .is("deleted_at", null)
            .lt(
              "checked_out_at",
              new Date(Date.now() - DEFAULT_DUE_HOURS * 60 * 60 * 1000).toISOString()
            ),
          adminClient
            .from("gear")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .not("status", "in", "(available,checked_out)"),
          adminClient
            .from("gear_status_history")
            .select("id, status, changed_at, gear:gear_id(name, barcode)")
            .eq("tenant_id", tenantId)
            .order("changed_at", { ascending: false })
            .limit(8),
          loadPolicy(),
        ]);

      const dueCutoffIso = new Date(
        Date.now() - policy.due_hours * 60 * 60 * 1000
      ).toISOString();
      const { count: overdueCount, error: overdueError } = await adminClient
        .from("gear")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "checked_out")
        .is("deleted_at", null)
        .lt("checked_out_at", dueCutoffIso);

      return jsonResponse(200, {
        data: {
          overdue_count: overdueError ? 0 : overdueCount ?? overdueCountResult.count ?? 0,
          flagged_count: statusCountResult.error ? 0 : statusCountResult.count ?? 0,
          due_hours: policy.due_hours,
          escalation_level_1_hours: policy.escalation_level_1_hours,
          escalation_level_2_hours: policy.escalation_level_2_hours,
          escalation_level_3_hours: policy.escalation_level_3_hours,
          maintenance,
          recent_status_events: recentStatusResult.error ? [] : recentStatusResult.data ?? [],
        },
      });
    }

    if (action === "get_status_tracking") {
      if (profile.role !== "tenant_admin") {
        return jsonResponse(403, { error: "Access denied" });
      }

      const [flaggedResult, policy, historyBaseResult] = await Promise.all([
        adminClient
          .from("gear")
          .select("id, name, barcode, serial_number, status, notes, updated_at, created_at")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .not("status", "in", "(available,checked_out)")
          .order("updated_at", { ascending: false })
          .limit(400),
        loadPolicy(),
        adminClient
          .from("gear_status_history")
          .select("id, gear_id, status, note, changed_at, changed_by")
          .eq("tenant_id", tenantId)
          .order("changed_at", { ascending: false })
          .limit(600),
      ]);

      let flaggedItems: Array<{
        id: string;
        name: string;
        barcode: string;
        serial_number: string | null;
        status: string;
        notes: string | null;
        updated_at: string;
      }> = [];

      if (flaggedResult.error) {
        if (isMissingColumn(flaggedResult.error as RpcError, "updated_at")) {
          const fallbackFlagged = await adminClient
            .from("gear")
            .select("id, name, barcode, serial_number, status, notes, created_at")
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .not("status", "in", "(available,checked_out)")
            .order("created_at", { ascending: false })
            .limit(400);
          if (fallbackFlagged.error) {
            console.error("admin-ops get_status_tracking flagged fallback failed", {
              message: fallbackFlagged.error.message,
              code: fallbackFlagged.error.code,
            });
            return jsonResponse(400, { error: "Unable to load status tracking." });
          }
          flaggedItems = ((fallbackFlagged.data ?? []) as Array<{
            id: string;
            name: string;
            barcode: string;
            serial_number: string | null;
            status: string;
            notes: string | null;
            created_at: string;
          }>).map((item) => ({
            ...item,
            updated_at: item.created_at,
          }));
        } else {
          console.error("admin-ops get_status_tracking flagged query failed", {
            message: flaggedResult.error.message,
            code: flaggedResult.error.code,
          });
          return jsonResponse(400, { error: "Unable to load status tracking." });
        }
      } else {
        flaggedItems = ((flaggedResult.data ?? []) as Array<{
          id: string;
          name: string;
          barcode: string;
          serial_number: string | null;
          status: string;
          notes: string | null;
          updated_at?: string | null;
          created_at?: string | null;
        }>).map((item) => ({
          id: item.id,
          name: item.name,
          barcode: item.barcode,
          serial_number: item.serial_number,
          status: item.status,
          notes: item.notes,
          updated_at: item.updated_at ?? item.created_at ?? new Date().toISOString(),
        }));
      }

      let history: Array<{
        id: string;
        gear_id: string;
        status: string;
        note: string | null;
        changed_at: string;
        changed_by: string | null;
        gear: { name: string; barcode: string } | null;
      }> = [];

      if (historyBaseResult.error) {
        if (!isMissingRelation(historyBaseResult.error as RpcError, "gear_status_history")) {
          console.error("admin-ops get_status_tracking history query failed", {
            message: historyBaseResult.error.message,
            code: historyBaseResult.error.code,
          });
          return jsonResponse(400, { error: "Unable to load status tracking." });
        }
      } else {
        const historyRows = (historyBaseResult.data ?? []) as Array<{
          id: string;
          gear_id: string;
          status: string;
          note: string | null;
          changed_at: string;
          changed_by: string | null;
        }>;
        const gearIds = Array.from(new Set(historyRows.map((row) => row.gear_id)));
        const { data: gearRows } = gearIds.length
          ? await adminClient.from("gear").select("id, name, barcode").in("id", gearIds)
          : { data: [] };
        const gearMap = new Map(
          ((gearRows ?? []) as Array<{ id: string; name: string; barcode: string }>).map((row) => [
            row.id,
            { name: row.name, barcode: row.barcode },
          ])
        );
        history = historyRows.map((row) => ({
          ...row,
          gear: gearMap.get(row.gear_id) ?? null,
        }));
      }

      return jsonResponse(200, {
        data: {
          due_hours: policy.due_hours,
          escalation_level_1_hours: policy.escalation_level_1_hours,
          escalation_level_2_hours: policy.escalation_level_2_hours,
          escalation_level_3_hours: policy.escalation_level_3_hours,
          flagged_items: flaggedItems,
          history,
        },
      });
    }

    if (action === "set_due_policy") {
      if (profile.role !== "tenant_admin") {
        return jsonResponse(403, { error: "Access denied" });
      }
      const policy = normalizeEscalationPolicy(
        (payload ?? {}).checkout_due_hours,
        (payload ?? {}).escalation_level_1_hours,
        (payload ?? {}).escalation_level_2_hours,
        (payload ?? {}).escalation_level_3_hours
      );
      if (policy.due_hours < 1 || policy.due_hours > 24 * 30) {
        return jsonResponse(400, { error: "Invalid due time limit." });
      }

      const { data, error } = await adminClient
        .from("tenant_policies")
        .upsert(
          {
            tenant_id: tenantId,
            checkout_due_hours: policy.due_hours,
            escalation_level_1_hours: policy.escalation_level_1_hours,
            escalation_level_2_hours: policy.escalation_level_2_hours,
            escalation_level_3_hours: policy.escalation_level_3_hours,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id" }
        )
        .select(duePolicySelect)
        .single();

      if (error || !data) {
        return jsonResponse(400, { error: "Unable to save due time limit." });
      }

      return jsonResponse(200, { data });
    }

    if (action === "send_overdue_reminders") {
      if (profile.role !== "tenant_admin") {
        return jsonResponse(403, { error: "Access denied" });
      }

      const policy = await loadPolicy();

      const { data: overdueRows, error: overdueError } = await adminClient
        .from("gear")
        .select(
          "id, name, barcode, checked_out_at, student:checked_out_by(first_name, last_name, student_id, email)"
        )
        .eq("tenant_id", tenantId)
        .eq("status", "checked_out")
        .is("deleted_at", null)
        .lt(
          "checked_out_at",
          new Date(Date.now() - policy.due_hours * 60 * 60 * 1000).toISOString()
        )
        .limit(500);

      if (overdueError) {
        return jsonResponse(400, { error: "Unable to load overdue items." });
      }

      const grouped = new Map<
        string,
        {
          student_name: string;
          student_id: string;
          max_level: number;
          items: Array<{ name: string; barcode: string; checked_out_at: string | null; level: number }>;
        }
      >();

      for (const row of (overdueRows ?? []) as Array<{
        name: string;
        barcode: string;
        checked_out_at: string | null;
        student:
          | {
              first_name: string;
              last_name: string;
              student_id: string;
              email?: string | null;
            }
          | Array<{
              first_name: string;
              last_name: string;
              student_id: string;
              email?: string | null;
            }>
          | null;
      }>) {
        const student = Array.isArray(row.student) ? row.student[0] ?? null : row.student;
        const email = (student?.email ?? "").trim().toLowerCase();
        if (!email) {
          continue;
        }

        const checkedOutAtMs = row.checked_out_at ? Date.parse(row.checked_out_at) : NaN;
        const hoursOverdue = Number.isNaN(checkedOutAtMs)
          ? policy.due_hours
          : Math.max(0, (Date.now() - checkedOutAtMs) / (1000 * 60 * 60));
        const level =
          hoursOverdue >= policy.escalation_level_3_hours
            ? 3
            : hoursOverdue >= policy.escalation_level_2_hours
            ? 2
            : hoursOverdue >= policy.escalation_level_1_hours
            ? 1
            : 0;

        if (!grouped.has(email)) {
          grouped.set(email, {
            student_name: `${student?.first_name ?? ""} ${student?.last_name ?? ""}`.trim(),
            student_id: student?.student_id ?? "",
            max_level: level,
            items: [],
          });
        }

        const bucket = grouped.get(email);
        if (bucket) {
          bucket.max_level = Math.max(bucket.max_level, level);
          bucket.items.push({
            name: row.name,
            barcode: row.barcode,
            checked_out_at: row.checked_out_at,
            level,
          });
        }
      }

      if (!grouped.size) {
        return jsonResponse(200, {
          data: {
            sent: 0,
            recipients: 0,
            due_hours: policy.due_hours,
            escalation_level_1_hours: policy.escalation_level_1_hours,
            escalation_level_2_hours: policy.escalation_level_2_hours,
            escalation_level_3_hours: policy.escalation_level_3_hours,
          },
        });
      }

      const resendApiKey = Deno.env.get("ITX_RESEND_API_KEY") ?? "";
      const emailFrom = Deno.env.get("ITX_EMAIL_FROM") ?? "support@itemtraxx.com";

      if (!resendApiKey) {
        return jsonResponse(400, {
          error:
            "Email provider is not configured. Set ITX_RESEND_API_KEY to send reminders.",
        });
      }

      let sent = 0;
      const escalationStats = { level_1: 0, level_2: 0, level_3: 0 };

      for (const [email, studentData] of grouped) {
        const subjectPrefix =
          studentData.max_level >= 3
            ? "Final notice"
            : studentData.max_level === 2
            ? "Second notice"
            : studentData.max_level === 1
            ? "Reminder"
            : "Overdue notice";

        const itemRows = studentData.items
          .map((item) => {
            const dateLabel = item.checked_out_at
              ? new Date(item.checked_out_at).toLocaleString()
              : "unknown time";
            return `<li>${item.name} (${item.barcode}) - checked out ${dateLabel}</li>`;
          })
          .join("");

        const html = `
          <p>Hello ${studentData.student_name || "Student"},</p>
          <p>${subjectPrefix}: the following item(s) are overdue.</p>
          <ul>${itemRows}</ul>
          <p>Due limit: ${policy.due_hours} hours.</p>
          <p>Please return these items as soon as possible.</p>
        `;

        try {
          await sendReminderEmail(
            resendApiKey,
            emailFrom,
            email,
            `${subjectPrefix} - ItemTraxx overdue item`,
            html
          );
          sent += 1;
          if (studentData.max_level === 1) escalationStats.level_1 += 1;
          if (studentData.max_level === 2) escalationStats.level_2 += 1;
          if (studentData.max_level >= 3) escalationStats.level_3 += 1;
        } catch (emailError) {
          console.error("overdue reminder send failed", {
            email,
            message: emailError instanceof Error ? emailError.message : "Unknown error",
          });
        }
      }

      return jsonResponse(200, {
        data: {
          sent,
          recipients: grouped.size,
          due_hours: policy.due_hours,
          escalation_level_1_hours: policy.escalation_level_1_hours,
          escalation_level_2_hours: policy.escalation_level_2_hours,
          escalation_level_3_hours: policy.escalation_level_3_hours,
          escalation_recipients: escalationStats,
        },
      });
    }

    if (action === "bulk_import_gear") {
      if (profile.role !== "tenant_admin") {
        return jsonResponse(403, { error: "Access denied" });
      }

      const rawRows = Array.isArray((payload as Record<string, unknown>)?.rows)
        ? ((payload as Record<string, unknown>).rows as Array<Record<string, unknown>>)
        : [];

      if (!rawRows.length || rawRows.length > 1000) {
        return jsonResponse(400, { error: "Provide between 1 and 1000 rows." });
      }

      const skippedRows: Array<{ barcode: string; reason: string }> = [];
      const normalizedRows: Array<{
        name: string;
        barcode: string;
        serial_number: string | null;
        status: string;
        notes: string | null;
      }> = [];

      const seenBarcodes = new Set<string>();

      for (const row of rawRows) {
        const name = typeof row.name === "string" ? row.name.trim() : "";
        const barcode = typeof row.barcode === "string" ? row.barcode.trim() : "";
        const serial = typeof row.serial_number === "string" ? row.serial_number.trim() : "";
        const statusRaw = typeof row.status === "string" ? row.status.trim() : "available";
        const notes = typeof row.notes === "string" ? row.notes.trim() : "";

        if (!name || !barcode) {
          skippedRows.push({ barcode: barcode || "(blank)", reason: "Missing name or barcode." });
          continue;
        }
        if (name.length > 120 || barcode.length > 64 || serial.length > 64 || notes.length > 500) {
          skippedRows.push({ barcode, reason: "Field length exceeded." });
          continue;
        }
        if (!ALLOWED_GEAR_STATUSES.has(statusRaw)) {
          skippedRows.push({ barcode, reason: "Invalid status." });
          continue;
        }
        if (seenBarcodes.has(barcode.toLowerCase())) {
          skippedRows.push({ barcode, reason: "Duplicate barcode in import." });
          continue;
        }

        seenBarcodes.add(barcode.toLowerCase());
        normalizedRows.push({
          name,
          barcode,
          serial_number: serial || null,
          status: statusRaw,
          notes: notes || null,
        });
      }

      if (!normalizedRows.length) {
        return jsonResponse(200, {
          data: {
            inserted: 0,
            skipped: skippedRows.length,
            inserted_items: [],
            skipped_rows: skippedRows,
          },
        });
      }

      const lookupBarcodes = normalizedRows.map((row) => row.barcode);
      const { data: existingRows } = await adminClient
        .from("gear")
        .select("barcode")
        .eq("tenant_id", tenantId)
        .in("barcode", lookupBarcodes);
      const existing = new Set((existingRows ?? []).map((row) => (row as { barcode: string }).barcode));

      const toInsert = normalizedRows.filter((row) => {
        const isExisting = existing.has(row.barcode);
        if (isExisting) {
          skippedRows.push({ barcode: row.barcode, reason: "Barcode already exists." });
        }
        return !isExisting;
      });

      if (!toInsert.length) {
        return jsonResponse(200, {
          data: {
            inserted: 0,
            skipped: skippedRows.length,
            inserted_items: [],
            skipped_rows: skippedRows,
          },
        });
      }

      const insertPayload = toInsert.map((row) => ({
        tenant_id: tenantId,
        name: row.name,
        barcode: row.barcode,
        serial_number: row.serial_number,
        status: row.status,
        notes: row.notes,
      }));

      const { data: insertedRows, error: insertError } = await adminClient
        .from("gear")
        .insert(insertPayload)
        .select("id, tenant_id, name, barcode, serial_number, status, notes");

      if (insertError) {
        return jsonResponse(400, { error: "Unable to import item rows." });
      }

      const historyPayload = (insertedRows ?? [])
        .filter((item) => TRACKED_STATUSES.has((item as { status: string }).status))
        .map((item) => ({
          tenant_id: tenantId,
          gear_id: (item as { id: string }).id,
          status: (item as { status: string }).status,
          note: (item as { notes?: string | null }).notes ?? null,
          changed_by: user.id,
        }));
      if (historyPayload.length) {
        await adminClient.from("gear_status_history").insert(historyPayload);
      }

      return jsonResponse(200, {
        data: {
          inserted: (insertedRows ?? []).length,
          skipped: skippedRows.length,
          inserted_items: insertedRows ?? [],
          skipped_rows: skippedRows,
        },
      });
    }

    return jsonResponse(400, { error: "Invalid action" });
  } catch (error) {
    console.error("admin-ops function error", {
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    return new Response(JSON.stringify({ error: "Request failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
