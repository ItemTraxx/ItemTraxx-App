import { supabase } from "./supabaseClient";
import { invokeEdgeFunction } from "./edgeFunctionClient";

type CheckoutReturnPayload = {
  student_id: string;
  gear_barcodes: string[];
  action_type: "checkout" | "return" | "auto" | "admin_return";
};

export const submitCheckoutReturn = async (
  payload: CheckoutReturnPayload
) => {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session ?? null;

  if (!session?.access_token) {
    throw new Error("Unauthorized.");
  }

  const result = await invokeEdgeFunction("checkoutReturn", {
    method: "POST",
    body: payload,
    accessToken: session.access_token,
  });

  if (!result.ok) {
    if (result.status === 429) {
      throw new Error("Rate limit exceeded, please try again in a minute.");
    }
    throw new Error(result.error || "Request failed.");
  }

  return result.data;
};

export type StudentSummary = {
  id: string;
  first_name: string;
  last_name: string;
  student_id: string;
};

export type GearSummary = {
  id: string;
  name: string;
  barcode: string;
  status: string;
};

export const fetchGearByBarcode = async (barcode: string) => {
  const { data, error } = await supabase
    .from("gear")
    .select("id, name, barcode, status")
    .eq("barcode", barcode)
    .single();

  if (error) {
    throw new Error("Invalid barcode.");
  }

  return data as GearSummary;
};

export const fetchStudentByStudentId = async (studentId: string) => {
  const { data, error } = await supabase
    .from("students")
    .select("id, first_name, last_name, student_id")
    .eq("student_id", studentId)
    .single();

  if (error) {
    throw new Error("Student not found.");
  }

  return data as StudentSummary;
};

export const fetchCheckedOutGear = async (studentUuid: string) => {
  const { data, error } = await supabase
    .from("gear")
    .select("id, name, barcode, status")
    .eq("checked_out_by", studentUuid);

  if (error) {
    throw new Error("Unable to load gear.");
  }

  return (data ?? []) as GearSummary[];
};
