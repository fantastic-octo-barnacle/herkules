/**
 * `?login_error=` on /account. The code union is deliberately OPEN
 * (`LoginFailureCode` ends in `string & {}`) because the issuer can fail a login
 * with codes of its own (`access_denied`, …): the five codes
 * `@herkules/oauth-client` itself produces get a line, everything else gets the
 * default. Exhaustiveness is therefore not available and not claimed.
 */
import type { LoginFailureCode } from "@herkules/oauth-client";

export const LOGIN_ERROR_TEXT: Partial<Record<LoginFailureCode, string>> = {
  invalid_state: "登录已过期，请重试。",
  invalid_request: "登录请求无效。",
  invalid_grant: "登录未被接受，请重试。",
  client_auth: "站点配置错误（客户端凭据）。",
  unavailable: "登录服务暂时不可用。",
};

export const LOGIN_ERROR_DEFAULT = "登录失败。";

/** `undefined` when there is no error at all; the default line for an unknown code. */
export function loginErrorText(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return LOGIN_ERROR_TEXT[code] ?? LOGIN_ERROR_DEFAULT;
}
