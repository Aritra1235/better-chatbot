import "server-only";

import { createOllama } from "ollama-ai-provider-v2";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { xai } from "@ai-sdk/xai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { createGroq } from "@ai-sdk/groq";
import { LanguageModel } from "ai";
import {
  createOpenAICompatibleModels,
  openaiCompatibleModelsSafeParse,
} from "./create-openai-compatiable";
import { ChatModel } from "app-types/chat";
import { openRouterPricingRepository } from "lib/db/repository";

type ModelMap = Record<string, LanguageModel>;

const ollama = createOllama({
  baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
});
const groq = createGroq({
  baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

const staticModels = {
  openai: {
    "gpt-4.1": openai("gpt-4.1"),
    "gpt-4.1-mini": openai("gpt-4.1-migrate"),
    "o4-mini": openai("o4-mini"),
    o3: openai("o3"),
    "gpt-5": openai("gpt-5"),
    "gpt-5-mini": openai("gpt-5-mini"),
    "gpt-5-nano": openai("gpt-5-nano"),
  },
  google: {
    "gemini-2.5-flash-lite": google("gemini-2.5-flash-lite"),
    "gemini-2.5-flash": google("gemini-2.5-flash"),
    "gemini-2.5-pro": google("gemini-2.5-pro"),
  },
  anthropic: {
    "claude-4-sonnet": anthropic("claude-4-sonnet-20250514"),
    "claude-4-opus": anthropic("claude-4-opus-20250514"),
    "claude-3-7-sonnet": anthropic("claude-3-7-sonnet-20250219"),
  },
  xai: {
    "grok-4": xai("grok-4"),
    "grok-4-fast": xai("grok-4-fast-non-reasoning"),
    "grok-3": xai("grok-3"),
    "grok-3-mini": xai("grok-3-mini"),
  },
  ollama: {
    "gemma3:1b": ollama("gemma3:1b"),
    "gemma3:4b": ollama("gemma3:4b"),
    "gemma3:12b": ollama("gemma3:12b"),
  },
  groq: {
    "kimi-k2-instruct": groq("moonshotai/kimi-k2-instruct"),
    "llama-4-scout-17b": groq("meta-llama/llama-4-scout-17b-16e-instruct"),
    "gpt-oss-20b": groq("openai/gpt-oss-20b"),
    "gpt-oss-120b": groq("openai/gpt-oss-120b"),
    "qwen3-32b": groq("qwen/qwen3-32b"),
  },
  // openRouter models are dynamically loaded below; keep key present for typing
  openRouter: {} as ModelMap,
};

const staticUnsupportedModels = new Set([
  staticModels.openai["o4-mini"],
  staticModels.ollama["gemma3:1b"],
  staticModels.ollama["gemma3:4b"],
  staticModels.ollama["gemma3:12b"],
]);

const openaiCompatibleProviders = openaiCompatibleModelsSafeParse(
  process.env.OPENAI_COMPATIBLE_DATA,
);

const {
  providers: openaiCompatibleModels,
  unsupportedModels: openaiCompatibleUnsupportedModels,
} = createOpenAICompatibleModels(openaiCompatibleProviders);

// Dynamic OpenRouter models: initialized with defaults, then refreshed periodically
const OPENROUTER_MODELS_ENDPOINT =
  (process.env.OPENROUTER_BASE_URL?.replace(/\/$/, "") ||
    "https://openrouter.ai/api/v1") + "/models";

let openRouterDynamicModels: ModelMap = {
  "gpt-oss-20b:free": openrouter("openai/gpt-oss-20b:free"),
  "qwen3-8b:free": openrouter("qwen/qwen3-8b:free"),
  "qwen3-14b:free": openrouter("qwen/qwen3-14b:free"),
  "qwen3-coder:free": openrouter("qwen/qwen3-coder:free"),
  "deepseek-r1:free": openrouter("deepseek/deepseek-r1-0528:free"),
  "deepseek-v3:free": openrouter("deepseek/deepseek-chat-v3-0324:free"),
  "gemini-2.0-flash-exp:free": openrouter("google/gemini-2.0-flash-exp:free"),
};

async function refreshOpenRouterModels() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === "****") return;

  try {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    const list = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];
    const fresh: ModelMap = {};
    const upserts: Array<Promise<any>> = [];
    for (const m of list) {
      const id: string | undefined = m?.id;
      if (!id || typeof id !== "string") continue;
      fresh[id] = openrouter(id);
      const pricing = m?.pricing;
      if (pricing && pricing.prompt && pricing.completion) {
        const promptPrice = Number(pricing.prompt);
        const completionPrice = Number(pricing.completion);
        const requestPrice = pricing.request ? Number(pricing.request) : null;
        if (!Number.isNaN(promptPrice) && !Number.isNaN(completionPrice)) {
          upserts.push(
            openRouterPricingRepository.upsert({
              modelId: id,
              promptPrice,
              completionPrice,
              requestPrice,
              currency: "USD",
            }),
          );
        }
      }
    }
    if (Object.keys(fresh).length > 0) {
      openRouterDynamicModels = fresh;
    }
    if (upserts.length) {
      await Promise.allSettled(upserts);
    }
  } catch {
    // Swallow errors; keep previous map
  }
}

const OPENROUTER_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let openRouterRefreshTimer: NodeJS.Timeout | undefined;
function startOpenRouterRefreshSchedule() {
  if (!checkProviderAPIKey("openRouter")) return;
  // Initial refresh at startup
  void refreshOpenRouterModels();
  if (!openRouterRefreshTimer) {
    openRouterRefreshTimer = setInterval(() => {
      void refreshOpenRouterModels();
    }, OPENROUTER_REFRESH_INTERVAL_MS);
  }
}
startOpenRouterRefreshSchedule();

function getAllModels() {
  return {
    ...openaiCompatibleModels,
    ...{ ...staticModels, openRouter: openRouterDynamicModels },
  } as Record<string, ModelMap>;
}

const allUnsupportedModels = new Set([
  ...openaiCompatibleUnsupportedModels,
  ...staticUnsupportedModels,
]);

export const isToolCallUnsupportedModel = (model: LanguageModel) => {
  return allUnsupportedModels.has(model);
};

const fallbackModel = staticModels.openai["gpt-4.1"];

export const customModelProvider = {
  get modelsInfo() {
    const current = getAllModels();
    return Object.entries(current).map(([provider, models]) => ({
      provider,
      models: Object.entries(models).map(([name, model]) => ({
        name,
        isToolCallUnsupported: isToolCallUnsupportedModel(model),
      })),
      hasAPIKey: checkProviderAPIKey(provider as keyof typeof staticModels),
    }));
  },
  getModel: (model?: ChatModel): LanguageModel => {
    if (!model) return fallbackModel;
    const current = getAllModels();
    return current[model.provider]?.[model.model] || fallbackModel;
  },
};

function checkProviderAPIKey(provider: keyof typeof staticModels) {
  let key: string | undefined;
  switch (provider) {
    case "openai":
      key = process.env.OPENAI_API_KEY;
      break;
    case "google":
      key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      break;
    case "anthropic":
      key = process.env.ANTHROPIC_API_KEY;
      break;
    case "xai":
      key = process.env.XAI_API_KEY;
      break;
    case "ollama":
      key = process.env.OLLAMA_API_KEY;
      break;
    case "groq":
      key = process.env.GROQ_API_KEY;
      break;
    case "openRouter":
      key = process.env.OPENROUTER_API_KEY;
      break;
    default:
      return true; // assume the provider has an API key
  }
  return !!key && key != "****";
}
