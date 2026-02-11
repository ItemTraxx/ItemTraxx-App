type EdgeFunctionOptions<TBody> = {
  method?: "GET" | "POST";
  body?: TBody;
  accessToken?: string;
};

type EdgeFunctionResult<TData> = {
  ok: boolean;
  status: number;
  data: TData | null;
  error: string;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const getDirectFunctionsBaseUrl = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!supabaseUrl) {
    return "";
  }
  return `${trimTrailingSlash(supabaseUrl)}/functions/v1`;
};

export const getEdgeFunctionsBaseUrl = () => {
  const proxyUrl = import.meta.env.VITE_EDGE_PROXY_URL as string | undefined;
  if (proxyUrl?.trim()) {
    return `${trimTrailingSlash(proxyUrl)}/functions`;
  }
  return getDirectFunctionsBaseUrl();
};

const getDefaultHeaders = (accessToken?: string) => {
  const headers: Record<string, string> = {};
  const proxyUrl = import.meta.env.VITE_EDGE_PROXY_URL as string | undefined;
  const isUsingProxy = !!proxyUrl?.trim();

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (!isUsingProxy) {
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (anonKey) {
      headers.apikey = anonKey;
      if (!accessToken && !anonKey.startsWith("sb_publishable_")) {
        headers.Authorization = `Bearer ${anonKey}`;
      }
    }
  }

  return headers;
};

export const invokeEdgeFunction = async <TData = unknown, TBody = unknown>(
  functionName: string,
  options: EdgeFunctionOptions<TBody> = {}
): Promise<EdgeFunctionResult<TData>> => {
  const baseUrl = getEdgeFunctionsBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: "Missing configuration.",
    };
  }

  const method = options.method ?? "POST";
  const headers = getDefaultHeaders(options.accessToken);
  const init: RequestInit = { method, headers };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(`${baseUrl}/${functionName}`, init);
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    const payload = parsed as
      | { error?: string; message?: string }
      | null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: payload?.error || payload?.message || "Request failed.",
      };
    }

    return {
      ok: true,
      status: response.status,
      data: (parsed as TData) ?? null,
      error: "",
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: "Network request failed.",
    };
  }
};
