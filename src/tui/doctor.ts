import { resolveRawConfig } from "../config/env.js";
import { getAIConfig, type AIProviderName } from "../ai/provider.js";
import type { Config } from "../config/env.js";

export interface CheckResult {
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  fix?: string;
}

const TOKEN_PATTERN = /^\d+~[A-Za-z0-9]+$/;

export function validateTokenFormat(token: string): CheckResult {
  if ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))) {
    return {
      label: "Token format",
      status: "fail",
      detail: "Token is wrapped in quotes",
      fix: "Re-run `canvas-cli login` and paste the raw token without surrounding quotes.",
    };
  }
  if (token.toLowerCase().includes("paste") || token.toLowerCase().includes("your_token")) {
    return {
      label: "Token format",
      status: "fail",
      detail: "Token appears to be placeholder text",
      fix: "Generate a real token at your Canvas profile settings page, then run `canvas-cli login`.",
    };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return {
      label: "Token format",
      status: "warn",
      detail: "Token does not match expected Canvas pattern (numeric~alphanumeric)",
      fix: "If API calls are failing, regenerate your token at Canvas → Profile → Settings → New Access Token.",
    };
  }
  return {
    label: "Token format",
    status: "pass",
    detail: "Matches expected Canvas token pattern",
  };
}

async function checkCanvasConnectivity(config: Config): Promise<CheckResult> {
  const url = `${config.baseUrl}/users/self`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      return {
        label: "Canvas API",
        status: "fail",
        detail: "401 Unauthorized — token is invalid or revoked",
        fix: "Generate a new token at Canvas → Profile → Settings → New Access Token, then run `canvas-cli login`.",
      };
    }
    if (response.status === 403) {
      return {
        label: "Canvas API",
        status: "fail",
        detail: "403 Forbidden — token lacks required permissions",
        fix: "Ensure your token has not expired and has the correct scope.",
      };
    }
    if (!response.ok) {
      return {
        label: "Canvas API",
        status: "fail",
        detail: `HTTP ${response.status} ${response.statusText}`,
        fix: "Check your Canvas URL and try again. Your institution's Canvas may be down.",
      };
    }

    const elapsed = Date.now() - start;
    const user = (await response.json()) as { name?: string; id?: number };
    const remaining = response.headers.get("X-Rate-Limit-Remaining");
    const rateInfo = remaining ? ` · rate limit remaining: ${remaining}` : "";
    return {
      label: "Canvas API",
      status: "pass",
      detail: `Connected as ${user.name ?? "Unknown"} (id: ${user.id ?? "?"}) · ${elapsed}ms${rateInfo}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
      return {
        label: "Canvas API",
        status: "fail",
        detail: "DNS lookup failed — cannot resolve hostname",
        fix: "Check your Canvas URL and network connection.",
      };
    }
    if (message.includes("timeout") || message.includes("TimeoutError")) {
      return {
        label: "Canvas API",
        status: "fail",
        detail: "Connection timed out after 10s",
        fix: "Check your network connection. Your institution's Canvas may be slow or down.",
      };
    }
    return {
      label: "Canvas API",
      status: "fail",
      detail: `Connection failed: ${message}`,
      fix: "Check your network connection and Canvas URL.",
    };
  }
}

async function checkAIProvider(provider: AIProviderName): Promise<CheckResult> {
  const endpoints: Record<AIProviderName, { url: string; headerKey: string; envKey: string }> = {
    openai: {
      url: "https://api.openai.com/v1/models",
      headerKey: "Authorization",
      envKey: "OPENAI_API_KEY",
    },
    anthropic: {
      url: "https://api.anthropic.com/v1/messages",
      headerKey: "x-api-key",
      envKey: "ANTHROPIC_API_KEY",
    },
    google: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headerKey: "x-goog-api-key",
      envKey: "GOOGLE_API_KEY",
    },
    bedrock: {
      url: "",
      headerKey: "",
      envKey: "AWS_ACCESS_KEY_ID",
    },
  };

  const ep = endpoints[provider];
  const key = process.env[ep.envKey];

  if (!key) {
    return {
      label: "AI provider",
      status: "fail",
      detail: `${provider} key not found (${ep.envKey})`,
      fix: `Run \`canvas-cli login\` and configure your ${provider} API key.`,
    };
  }

  if (provider === "bedrock") {
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!secretKey) {
      return {
        label: "AI provider",
        status: "fail",
        detail: "AWS_SECRET_ACCESS_KEY not found",
        fix: "Run `canvas-cli login` and configure your AWS Bedrock credentials.",
      };
    }
    return {
      label: "AI provider",
      status: "warn",
      detail: `bedrock credentials present but not verified (region: ${process.env.AWS_REGION ?? "not set"})`,
      fix: "Bedrock uses SigV4 auth which cannot be validated with a simple request. Verify by running an AI command.",
    };
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider === "anthropic") {
      headers[ep.headerKey] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["Content-Type"] = "application/json";
    } else if (provider === "openai") {
      headers[ep.headerKey] = `Bearer ${key}`;
    } else if (provider !== "google") {
      headers[ep.headerKey] = key;
    }

    const response = await fetch(
      provider === "google" ? `${ep.url}?key=${key}` : ep.url,
      {
        method: provider === "anthropic" ? "POST" : "GET",
        headers,
        ...(provider === "anthropic" ? { body: JSON.stringify({ model: "_", max_tokens: 1, messages: [] }) } : {}),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (response.status === 401 || response.status === 403) {
      return {
        label: "AI provider",
        status: "fail",
        detail: `${provider} key is invalid or revoked (HTTP ${response.status})`,
        fix: `Check your ${provider} API key and regenerate if needed, then run \`canvas-cli login\`.`,
      };
    }

    // For Anthropic, a 400 with valid auth means the key works
    if (provider === "anthropic" && response.status === 400) {
      return {
        label: "AI provider",
        status: "pass",
        detail: `${provider} key is valid`,
      };
    }

    if (response.ok) {
      return {
        label: "AI provider",
        status: "pass",
        detail: `${provider} key is valid`,
      };
    }

    return {
      label: "AI provider",
      status: "warn",
      detail: `${provider} returned HTTP ${response.status} — key may still be valid`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timeout") || message.includes("TimeoutError")) {
      return {
        label: "AI provider",
        status: "warn",
        detail: `${provider} API timed out — key may still be valid`,
      };
    }
    return {
      label: "AI provider",
      status: "warn",
      detail: `Could not reach ${provider} API: ${message}`,
    };
  }
}

export async function runDoctor(): Promise<string> {
  const raw = resolveRawConfig();
  const { profile, baseUrl, accessToken: token, source: configSource } = raw;
  const results: CheckResult[] = [];

  // Check 1: Configuration source
  if (!baseUrl && !configSource) {
    results.push({
      label: "Configuration",
      status: "fail",
      detail: "No stored config or CANVAS_BASE_URL env var found",
      fix: "Run `canvas-cli login` to set up, or set CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN in your environment.",
    });
    return formatResults(profile, results);
  }

  if (configSource === "env") {
    results.push({
      label: "Configuration",
      status: "pass",
      detail: `Profile "${profile}" · Canvas URL: ${baseUrl} (from env)`,
    });
  } else {
    results.push({
      label: "Configuration",
      status: "pass",
      detail: `Profile "${profile}" loaded · Canvas URL: ${baseUrl}`,
    });
  }

  // Check 2: Canvas token presence & format
  if (!token) {
    results.push({
      label: "Canvas token",
      status: "fail",
      detail: "No token found in credential store or CANVAS_ACCESS_TOKEN env var",
      fix: "Run `canvas-cli login` to set up your access token, or set CANVAS_ACCESS_TOKEN in your environment.",
    });
  } else {
    const tokenSource = process.env.CANVAS_ACCESS_TOKEN ? " (from env)" : "";
    results.push({
      label: "Canvas token",
      status: "pass",
      detail: `Token found${tokenSource}`,
    });
    results.push(validateTokenFormat(token));
  }

  // Check 3: Canvas API connectivity
  if (token && baseUrl) {
    const normalized = baseUrl.replace(/\/+$/, "");
    const apiUrl = normalized.endsWith("/api/v1")
      ? normalized
      : `${normalized}/api/v1`;
    results.push(
      await checkCanvasConnectivity({ baseUrl: apiUrl, accessToken: token })
    );
  }

  // Check 4: AI provider
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    results.push({
      label: "AI provider",
      status: "skip",
      detail: "Not configured (optional — powers ask/work commands)",
      fix: "Run `canvas-cli login` to configure an AI provider.",
    });
  } else {
    results.push({
      label: "AI config",
      status: "pass",
      detail: `${aiConfig.provider} · ${aiConfig.model}${aiConfig.effort ? ` · effort: ${aiConfig.effort}` : ""}`,
    });
    results.push(await checkAIProvider(aiConfig.provider));
  }

  return formatResults(profile, results);
}

export function formatResults(profile: string, results: CheckResult[]): string {
  const lines: string[] = [];
  lines.push(`**Doctor** — profile: ${profile}\n`);

  const icons: Record<CheckResult["status"], string> = {
    pass: "✓",
    fail: "✗",
    warn: "!",
    skip: "–",
  };

  for (const r of results) {
    lines.push(`${icons[r.status]} **${r.label}**: ${r.detail}`);
    if (r.fix && r.status !== "pass") {
      lines.push(`  → ${r.fix}`);
    }
  }

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  lines.push("");
  if (failures === 0 && warnings === 0) {
    lines.push("**All checks passed.** Everything looks good.");
  } else if (failures > 0) {
    lines.push(`**${failures} issue${failures > 1 ? "s" : ""} found.** See fix instructions above.`);
  } else {
    lines.push(`**${warnings} warning${warnings > 1 ? "s" : ""}.** See details above.`);
  }

  return lines.join("\n");
}
