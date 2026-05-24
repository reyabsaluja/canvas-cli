import { getActiveProfile } from "../config/env.js";
import { readStoredConfig } from "../config/store.js";
import { loadCredential } from "../config/credentials.js";
import { getAIConfig, type AIProviderName } from "../ai/provider.js";
import type { Config } from "../config/env.js";

interface CheckResult {
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  fix?: string;
}

const TOKEN_PATTERN = /^\d+~[A-Za-z0-9]+$/;

function validateTokenFormat(token: string): CheckResult {
  const trimmed = token.trim();
  if (trimmed !== token) {
    return {
      label: "Token format",
      status: "fail",
      detail: "Token has leading or trailing whitespace",
      fix: "Re-run `canvas-cli login` and paste the token without extra spaces.",
    };
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return {
      label: "Token format",
      status: "fail",
      detail: "Token is wrapped in quotes",
      fix: "Re-run `canvas-cli login` and paste the raw token without surrounding quotes.",
    };
  }
  if (trimmed.toLowerCase().includes("paste") || trimmed.toLowerCase().includes("your_token")) {
    return {
      label: "Token format",
      status: "fail",
      detail: "Token appears to be placeholder text",
      fix: "Generate a real token at your Canvas profile settings page, then run `canvas-cli login`.",
    };
  }
  if (!TOKEN_PATTERN.test(trimmed)) {
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

    const user = (await response.json()) as { name?: string; id?: number };
    const remaining = response.headers.get("X-Rate-Limit-Remaining");
    const rateInfo = remaining ? ` · rate limit remaining: ${remaining}` : "";
    return {
      label: "Canvas API",
      status: "pass",
      detail: `Connected as ${user.name ?? "Unknown"} (id: ${user.id ?? "?"})${rateInfo}`,
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
      status: "pass",
      detail: `bedrock credentials present (region: ${process.env.AWS_REGION ?? "not set"})`,
    };
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider === "anthropic") {
      headers[ep.headerKey] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "openai") {
      headers[ep.headerKey] = `Bearer ${key}`;
    } else {
      headers[ep.headerKey] = key;
    }

    const response = await fetch(
      provider === "google" ? `${ep.url}?key=${key}` : ep.url,
      {
        method: provider === "anthropic" ? "POST" : "GET",
        headers,
        ...(provider === "anthropic" ? { body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }) } : {}),
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

    if (response.ok || response.status === 200) {
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
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  const results: CheckResult[] = [];

  // Check 1: Profile & config file
  if (!stored) {
    results.push({
      label: "Configuration",
      status: "fail",
      detail: "No stored config found",
      fix: "Run `canvas-cli login` to set up your configuration.",
    });
    return formatResults(profile, results);
  }

  results.push({
    label: "Configuration",
    status: "pass",
    detail: `Profile "${profile}" loaded · Canvas URL: ${stored.canvasBaseUrl}`,
  });

  // Check 2: Canvas token presence & format
  const token = loadCredential(profile, "canvas-token");
  if (!token) {
    results.push({
      label: "Canvas token",
      status: "fail",
      detail: "No token found in credential store",
      fix: "Run `canvas-cli login` to set up your access token.",
    });
  } else {
    results.push({
      label: "Canvas token",
      status: "pass",
      detail: "Token found in credential store",
    });
    results.push(validateTokenFormat(token));
  }

  // Check 3: Canvas API connectivity
  if (token && stored.canvasBaseUrl) {
    const apiUrl = stored.canvasBaseUrl.endsWith("/api/v1")
      ? stored.canvasBaseUrl
      : `${stored.canvasBaseUrl}/api/v1`;
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
      label: "AI model",
      status: "pass",
      detail: `${aiConfig.provider} · ${aiConfig.model}${aiConfig.effort ? ` · effort: ${aiConfig.effort}` : ""}`,
    });
    results.push(await checkAIProvider(aiConfig.provider));
  }

  return formatResults(profile, results);
}

function formatResults(profile: string, results: CheckResult[]): string {
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
