import type { Env } from './types';
import { ApiError } from './lib/errors';
import { readLimited } from './lib/stream';

const origin = 'https://api.cloudflare.com/client/v4';
export interface CloudflareEnvelope<T> {
  success: boolean; result: T;
  result_info?: { page?: number; per_page?: number; total_count?: number; total_pages?: number; count?: number };
  errors?: { code?: number; message?: string }[];
}
export interface CustomProvider { id: string; name: string; slug: string; base_url: string; enable?: boolean; description?: string; created_at?: string }
export function accountId(env: Env) {
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) throw new ApiError(503, 'cloudflare_setup_required', '请配置有效的 CLOUDFLARE_ACCOUNT_ID');
  return env.CLOUDFLARE_ACCOUNT_ID!;
}
export const gatewayId = (env: Env) => env.AI_GATEWAY_ID || 'default';
export function controlToken(env: Env) {
  if (!env.CF_API_TOKEN) throw new ApiError(503, 'cloudflare_setup_required', '请配置 CF_API_TOKEN，包含 AI Gateway 读写和 Account Analytics 读取权限');
  return env.CF_API_TOKEN;
}
export const inferenceToken = (env: Env) => env.CF_AIG_TOKEN || env.CF_API_TOKEN;
export const providerPath = (env: Env) => `/accounts/${accountId(env)}/ai-gateway/custom-providers`;
export const gatewayPath = (env: Env) => `/accounts/${accountId(env)}/ai-gateway/gateways/${encodeURIComponent(gatewayId(env))}`;

async function cloudflareFetch(env: Env, path: string, options: RequestInit = {}) {
  const token = controlToken(env);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  } catch { throw new ApiError(502, 'cloudflare_connection_error', '无法连接 Cloudflare API，请稍后重试'); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) throw new ApiError(502, 'cloudflare_permission_denied', 'Cloudflare 拒绝访问，请检查 CF_API_TOKEN 的账户范围与 AI Gateway / Account Analytics / Secrets Store 权限');
    if (response.status === 404) throw new ApiError(404, 'cloudflare_not_found', 'Cloudflare 上不存在该资源，请检查 Account ID、Gateway ID 或服务商 ID');
    if (response.status === 429) throw new ApiError(429, 'cloudflare_rate_limited', 'Cloudflare API 已限流，请稍后重试');
    throw new ApiError(response.status === 409 ? 409 : 502, 'cloudflare_api_error', `Cloudflare API 返回 ${response.status}；请检查服务商 slug 是否重复及配置是否有效`);
  }
  try { return JSON.parse(await readLimited(response)) as unknown; }
  catch { throw new ApiError(502, 'cloudflare_invalid_response', 'Cloudflare API 返回了无法读取的数据'); }
}
export async function cfApi<T>(env: Env, path: string, options?: RequestInit): Promise<CloudflareEnvelope<T>> {
  const data = await cloudflareFetch(env, path, options) as CloudflareEnvelope<T>;
  if (data.success !== true || data.result === undefined) throw new ApiError(502, 'cloudflare_api_error', 'Cloudflare 未成功完成操作，请检查资源配置与 Token 权限');
  return data;
}
export async function cfGraphql<T>(env: Env, query: string): Promise<T> {
  const result = await cloudflareFetch(env, '/graphql', { method: 'POST', body: JSON.stringify({ query }) }) as { data?: T; errors?: unknown[] };
  if (result.errors?.length || !result.data) throw new ApiError(502, 'cloudflare_analytics_error', 'Cloudflare 分析查询失败，请检查 Account Analytics 权限、查询时间范围和数据集可用性');
  return result.data;
}
export function publicProvider(provider: CustomProvider): CustomProvider {
  // Never return provider headers or secret-bearing configuration to the browser.
  return { id: provider.id, name: provider.name, slug: provider.slug, base_url: provider.base_url, enable: provider.enable, description: provider.description, created_at: provider.created_at };
}

export async function storeByok(env: Env, slug: string, alias: string, secret: string) {
  const storesPath = `/accounts/${accountId(env)}/secrets_store/stores`;
  let storeId = env.SECRETS_STORE_ID;
  if (!storeId) {
    const stores = await cfApi<{ id: string }[]>(env, `${storesPath}?per_page=2`);
    if (!Array.isArray(stores.result) || stores.result.length !== 1 || (stores.result_info?.total_count ?? 1) > 1) {
      throw new ApiError(503, 'secrets_store_setup_required', '请在 Cloudflare 创建 Secrets Store 并配置 SECRETS_STORE_ID；也可使用已存在的 BYOK 别名');
    }
    storeId = stores.result[0].id;
  }
  if (!/^[a-f0-9]{32}$/i.test(storeId)) throw new ApiError(503, 'secrets_store_setup_required', 'SECRETS_STORE_ID 格式无效');
  // AI Gateway resolves API-created secrets by this exact name, not by secret_id.
  const name = `${gatewayId(env)}_custom-${slug}_${alias}`;
  const created = await cfApi<{ id: string }[]>(env, `${storesPath}/${storeId}/secrets`, {
    method: 'POST', body: JSON.stringify([{ name, scopes: ['ai_gateway'], value: secret }]),
  });
  const id = created.result?.[0]?.id;
  if (!id) throw new ApiError(502, 'cloudflare_invalid_response', 'Cloudflare 未返回新建密钥 ID');
  try {
    await cfApi(env, `${gatewayPath(env)}/provider_configs`, { method: 'POST', body: JSON.stringify({ provider_slug: `custom-${slug}`, alias, default_config: false, secret_id: id }) });
  } catch (error) {
    const reason = error instanceof ApiError ? error.message : '关联失败';
    throw new ApiError(502, 'byok_association_failed', `${reason}；密钥已写入 Secrets Store（名称 ${name}），请在 Cloudflare 完成 BYOK 关联后使用别名 ${alias}`);
  }
}
