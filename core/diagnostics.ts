import { sanitizeEvidenceText } from "./summary.ts";
import type { DeliveryBackend, DeliveryFailure } from "./types.ts";
import { isRecord } from "./util.ts";

type FailureDetail = Pick<DeliveryFailure, "code" | "message">;

/** Only constructed with fixed text or validated numbers, never an external message. */
export class OperationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "OperationError";
		this.code = code;
	}
}

const SYSTEM_ERRORS: Record<string, string> = {
	ENOTFOUND: "DNS 解析失败，请检查网络和 DNS",
	EAI_AGAIN: "DNS 暂时不可用，请稍后重试",
	ECONNREFUSED: "连接被拒绝，请检查服务或代理",
	ECONNRESET: "连接被重置，请检查网络或代理",
	ENETUNREACH: "网络不可达，请检查网络或代理",
	EHOSTUNREACH: "目标主机不可达，请检查网络或代理",
	UND_ERR_SOCKET: "连接中断，请检查网络或代理",
	ETIMEDOUT: "连接超时，请检查网络或代理",
	UND_ERR_CONNECT_TIMEOUT: "连接超时，请检查网络或代理",
	UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
	UND_ERR_BODY_TIMEOUT: "读取响应超时",
	CERT_HAS_EXPIRED: "TLS 证书已过期",
	DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书不受信任，请检查代理证书",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书校验失败，请检查代理证书",
	SELF_SIGNED_CERT_IN_CHAIN: "TLS 证书链不受信任，请检查代理证书",
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "缺少可信的 TLS 签发证书，请检查代理证书",
	ERR_TLS_CERT_ALTNAME_INVALID: "TLS 证书与目标域名不匹配",
	ENOENT: "程序或文件不存在，请检查安装和路径",
	EACCES: "没有访问权限",
	EPERM: "操作被系统拒绝",
	ENOSPC: "磁盘空间不足",
};

/** Classify external errors without echoing potentially credential-bearing text. */
export function describeError(error: unknown): FailureDetail {
	if (error instanceof OperationError) return { code: error.code, message: error.message };
	let current = error;
	for (let depth = 0; depth < 4 && isRecord(current); depth++) {
		if (current.name === "TimeoutError") return { code: "timeout", message: "操作超时" };
		const code = typeof current.code === "string" ? current.code : "";
		if (Object.hasOwn(SYSTEM_ERRORS, code)) return { code, message: `${SYSTEM_ERRORS[code]}（${code}）` };
		current = current.cause;
	}
	// Shell tools often expose only stderr, without a machine-readable error code.
	const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	for (const [code, message] of Object.entries(SYSTEM_ERRORS)) {
		if (new RegExp(`\\b${code}\\b`, "i").test(text)) return { code, message: `${message}（${code}）` };
	}
	if (/command not found|not recognized as|no such file or directory/i.test(text)) {
		return { code: "not-found", message: "命令不存在，请检查安装和 PATH" };
	}
	if (/could not resolve|failed to resolve|no such host/i.test(text)) return { code: "dns", message: "DNS 解析失败" };
	if (/connection refused/i.test(text)) return { code: "connection-refused", message: "连接被拒绝" };
	if (/timed? ?out|deadline exceeded/i.test(text)) return { code: "timeout", message: "操作超时" };
	if (/certificate|\bTLS\b|\bSSL\b/i.test(text)) return { code: "tls", message: "TLS 连接或证书校验失败" };
	if (/unauthorized|unauthenticated|invalid.*(?:api.?key|token)|token.*expired|not logged in|login required|\b401\b/i.test(text)) {
		return { code: "authentication", message: "认证失败，请检查登录状态或凭据" };
	}
	if (/permission denied|forbidden|access denied|\b403\b/i.test(text)) return { code: "permission", message: "权限不足" };
	if (/too many requests|rate limit|\b429\b/i.test(text)) return { code: "rate-limit", message: "请求过于频繁，请稍后重试" };
	return { code: "unknown", message: "未提供可安全展示的错误原因" };
}

/** Redact known request values before generic redaction and truncation. */
export function safeErrorText(value: unknown, sensitive: readonly string[] = []): string | undefined {
	if (typeof value !== "string") return undefined;
	let text = value;
	for (const secret of [...new Set(sensitive)].filter(Boolean).sort((a, b) => b.length - a.length)) {
		text = text.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
	}
	text = text
		.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
		.replace(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
	return sanitizeEvidenceText(text, 240);
}

const BACKEND_NAMES: Record<DeliveryBackend, string> = { fishaudio: "Fish Audio", bark: "Bark" };
const STAGE_NAMES: Record<DeliveryFailure["stage"], string> = {
	credentials: "配置取值失败", request: "请求失败", response: "响应异常",
	storage: "音频保存失败", playback: "播放失败", delivery: "通知失败",
};

export function formatDeliveryFailure(backend: DeliveryBackend, failure: DeliveryFailure): string {
	return `${BACKEND_NAMES[backend]} ${STAGE_NAMES[failure.stage]}：${failure.message}`;
}
