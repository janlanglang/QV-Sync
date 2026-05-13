declare module 'httpntlm' {
  interface NtlmOptions {
    url: string;
    username: string;
    password: string;
    domain?: string;
    workstation?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  interface NtlmResponse {
    statusCode?: number;
  }

  type NtlmCallback = (error: unknown, response: NtlmResponse, body: string) => void;

  export function get(options: NtlmOptions, callback: NtlmCallback): void;
  export function post(options: NtlmOptions, callback: NtlmCallback): void;
}
