import { invokeEdgeFunction } from "./edgeFunctionClient";
import { supabase } from "./supabaseClient";

export type StatusTrackedItem = {
  id: string;
  name: string;
  barcode: string;
  serial_number: string | null;
  status: string;
  notes: string | null;
  updated_at: string;
};

export type StatusHistoryItem = {
  id: string;
  gear_id: string;
  status: string;
  note: string | null;
  changed_at: string;
  changed_by: string | null;
  gear: { name: string; barcode: string } | null;
};

export type TenantNotificationPayload = {
  overdue_count: number;
  flagged_count: number;
  due_hours: number;
  escalation_level_1_hours: number;
  escalation_level_2_hours: number;
  escalation_level_3_hours: number;
  maintenance: { enabled: boolean; message: string } | null;
  recent_status_events: StatusHistoryItem[];
};

type AdminOpsAction =
  | "get_notifications"
  | "get_status_tracking"
  | "set_due_policy"
  | "send_overdue_reminders"
  | "bulk_import_gear";

const getAccessToken = async () => {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error("Unauthorized");
  }
  return data.session.access_token;
};

const callAdminOps = async <TData>(
  action: AdminOpsAction,
  payload: Record<string, unknown> = {}
) => {
  const accessToken = await getAccessToken();
  const result = await invokeEdgeFunction<{ data?: TData }, { action: string; payload: Record<string, unknown> }>(
    "admin-ops",
    {
      method: "POST",
      accessToken,
      body: { action, payload },
    }
  );

  if (!result.ok) {
    throw new Error(result.error || "Request failed.");
  }

  return result.data?.data as TData;
};

export const fetchTenantNotifications = async () =>
  callAdminOps<TenantNotificationPayload>("get_notifications");

export const fetchStatusTracking = async () =>
  callAdminOps<{
    due_hours: number;
    escalation_level_1_hours: number;
    escalation_level_2_hours: number;
    escalation_level_3_hours: number;
    flagged_items: StatusTrackedItem[];
    history: StatusHistoryItem[];
  }>("get_status_tracking");

export const saveDuePolicy = async (
  checkoutDueHours: number,
  escalationLevel1Hours: number,
  escalationLevel2Hours: number,
  escalationLevel3Hours: number
) =>
  callAdminOps<{
    checkout_due_hours: number;
    escalation_level_1_hours: number;
    escalation_level_2_hours: number;
    escalation_level_3_hours: number;
  }>("set_due_policy", {
    checkout_due_hours: checkoutDueHours,
    escalation_level_1_hours: escalationLevel1Hours,
    escalation_level_2_hours: escalationLevel2Hours,
    escalation_level_3_hours: escalationLevel3Hours,
  });

export const sendOverdueReminders = async () =>
  callAdminOps<{
    sent: number;
    recipients: number;
    due_hours: number;
    escalation_level_1_hours: number;
    escalation_level_2_hours: number;
    escalation_level_3_hours: number;
    escalation_recipients?: { level_1: number; level_2: number; level_3: number };
  }>("send_overdue_reminders");

export const bulkImportGear = async (
  rows: Array<{
    name: string;
    barcode: string;
    serial_number?: string;
    status?: string;
    notes?: string;
  }>
) =>
  callAdminOps<{
    inserted: number;
    skipped: number;
    inserted_items: StatusTrackedItem[];
    skipped_rows: Array<{ barcode: string; reason: string }>;
  }>("bulk_import_gear", { rows });
