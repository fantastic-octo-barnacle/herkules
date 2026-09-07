/**
 * Better Auth's signed OAuth continuation is a protocol message, not router state.
 * Read it from the browser address bar because routers may normalize repeated
 * fields. Only fields named by Better Auth's repeated `ba_param` markers are
 * forwarded, so page-only query parameters cannot invalidate the signature.
 */

const SIGNATURE = "sig";
const SIGNED_PARAMETER_NAME = "ba_param";

export interface OAuthPageQuery {
  readonly params: URLSearchParams;
  readonly continuation?: string;
}

export function readOAuthPageQuery(search: string = location.search): OAuthPageQuery {
  const params = new URLSearchParams(search);
  if (!params.has(SIGNATURE)) return { params };

  const signedNames = params.getAll(SIGNED_PARAMETER_NAME);
  const included = new Set(signedNames);
  const continuation = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === SIGNATURE || name === SIGNED_PARAMETER_NAME || included.has(name)) {
      continuation.append(name, value);
    }
  }
  return { params, continuation: continuation.toString() };
}
