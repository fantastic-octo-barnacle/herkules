/** The `?login_error=` line: five known codes, one default, nothing when there is no error. */
import { describe, expect, it } from "vite-plus/test";

import {
  LOGIN_ERROR_DEFAULT,
  LOGIN_ERROR_TEXT,
  loginErrorText,
} from "../src/account/loginError.ts";

describe("loginErrorText", () => {
  it("has a line for every code the client itself produces", () => {
    expect(Object.keys(LOGIN_ERROR_TEXT)).toEqual([
      "invalid_state",
      "invalid_request",
      "invalid_grant",
      "client_auth",
      "unavailable",
    ]);
    expect(loginErrorText("invalid_state")).toBe("登录已过期，请重试。");
    expect(loginErrorText("client_auth")).toBe("站点配置错误（客户端凭据）。");
  });

  it("falls back for an issuer-side code", () => {
    expect(loginErrorText("access_denied")).toBe(LOGIN_ERROR_DEFAULT);
  });

  it("is undefined when there is no error", () => {
    expect(loginErrorText(undefined)).toBeUndefined();
    expect(loginErrorText("")).toBeUndefined();
  });
});
