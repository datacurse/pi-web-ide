/** Only display metadata crosses HTTP; credentials stay in Pi's auth.json. */
export interface AuthProvider {
  id: string;
  name: string;
  stored: "api_key" | "oauth" | null;
  methods: { type: "api_key" | "oauth"; label: string }[];
}

export interface LoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface ProviderLogin {
  id: string;
  provider: string;
  state: "pending" | "complete" | "failed" | "cancelled";
  message?: string;
  url?: string;
  userCode?: string;
  prompt?: LoginPrompt;
}
