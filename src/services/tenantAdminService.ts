import { supabase } from "./supabaseClient";
import { invokeEdgeFunction } from "./edgeFunctionClient";

type CreateTenantAdminPayload = {
  new_email: string;
  new_password: string;
  current_password: string;
};

export type TenantAdminSummary = {
  id: string;
  auth_email: string | null;
  created_at: string | null;
};

export const fetchTenantAdmins = async () => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, auth_email, created_at")
    .eq("role", "tenant_admin")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error("Unable to load tenant admins.");
  }

  return (data ?? []) as TenantAdminSummary[];
};

export const createTenantAdmin = async (payload: CreateTenantAdminPayload) => {
  const { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData.session ?? null;
  const { data: refreshData } = await supabase.auth.refreshSession();
  if (refreshData?.session) {
    session = refreshData.session;
  }

  if (!session?.access_token) {
    throw new Error("Unauthorized.");
  }

  const accessToken = session.access_token;
  const result = await invokeEdgeFunction<{ success: boolean; user_id?: string }, CreateTenantAdminPayload>(
    "create-tenant-admin",
    {
      method: "POST",
      body: payload,
      accessToken,
    }
  );

  if (!result.ok) {
    const message = (result.error ?? "").toLowerCase();
    if (message.includes("credentials")) {
      throw new Error("Invalid credentials.");
    }
    throw new Error("Unable to create admin.");
  }

  return result.data as { success: boolean; user_id?: string };
};
