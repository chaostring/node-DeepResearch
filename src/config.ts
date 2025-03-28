import dotenv from 'dotenv';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI, OpenAIProviderSettings } from '@ai-sdk/openai';
import configJson from '../config.json';
// Load environment variables
dotenv.config();

// Types
// Define the supported large language model provider types
export type LLMProvider = 'openai' | 'gemini' | 'vertex';
// Define the tool name type, from the gemini tools in the configuration file
export type ToolName = keyof typeof configJson.models.gemini.tools;

// Type definitions for our config structure
// Environment configuration type
type EnvConfig = typeof configJson.env;

// Provider configuration interface
interface ProviderConfig {
  createClient: string;
  clientConfig?: Record<string, any>;
}

// Environment setup
// Copy environment configuration from the configuration file
const env: EnvConfig = { ...configJson.env };
// Iterate over all environment variables and overwrite the values in the configuration file if set
(Object.keys(env) as (keyof EnvConfig)[]).forEach(key => {
  if (process.env[key]) {
    env[key] = process.env[key] || env[key];
  }
});

// If a proxy is set, set the global proxy
if (env.https_proxy) {
  try {
    // Parse the proxy URL
    const proxyUrl = new URL(env.https_proxy).toString();
    // Create a proxy agent
    const dispatcher = new ProxyAgent({ uri: proxyUrl });
    // Set the global proxy
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    // Proxy setup failed, record the error
    console.error('Failed to set proxy:', error);
  }
}

// Export environment variables
export const OPENAI_BASE_URL = env.OPENAI_BASE_URL;
export const GEMINI_API_KEY = env.GEMINI_API_KEY;
export const OPENAI_API_KEY = env.OPENAI_API_KEY;
export const JINA_API_KEY = env.JINA_API_KEY;
export const BRAVE_API_KEY = env.BRAVE_API_KEY;
export const SERPER_API_KEY = env.SERPER_API_KEY;
export const SEARCH_PROVIDER = configJson.defaults.search_provider;
export const STEP_SLEEP = configJson.defaults.step_sleep;

// Determine LLM provider
export const LLM_PROVIDER: LLMProvider = (() => {
  // Prioritize environment variable settings, then use default values from the configuration file
  const provider = process.env.LLM_PROVIDER || configJson.defaults.llm_provider;
  // Validate the provider
  if (!isValidProvider(provider)) {
    throw new Error(`Invalid LLM provider: ${provider}`);
  }
  return provider;
})();

// Validate the provider is a valid LLM provider
function isValidProvider(provider: string): provider is LLMProvider {
  return provider === 'openai' || provider === 'gemini' || provider === 'vertex';
}

// Tool configuration interface
interface ToolConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

// Tool override configuration interface
interface ToolOverrides {
  temperature?: number;
  maxTokens?: number;
}

// Get tool configuration
export function getToolConfig(toolName: ToolName): ToolConfig {
  // Get the corresponding provider configuration (if vertex, use gemini's configuration)
  const providerConfig = configJson.models[LLM_PROVIDER === 'vertex' ? 'gemini' : LLM_PROVIDER];
  // Get the default configuration
  const defaultConfig = providerConfig.default;
  // Get the specific tool's override configuration
  const toolOverrides = providerConfig.tools[toolName] as ToolOverrides;

  // Return the final configuration, with tool-specific configuration overriding default configuration
  return {
    model: process.env.DEFAULT_MODEL_NAME || defaultConfig.model,
    temperature: toolOverrides.temperature ?? defaultConfig.temperature,
    maxTokens: toolOverrides.maxTokens ?? defaultConfig.maxTokens
  };
}

export function getMaxTokens(toolName: ToolName): number {
  return getToolConfig(toolName).maxTokens;
}

// Get model instance
export function getModel(toolName: ToolName) {
  // Get tool configuration
  const config = getToolConfig(toolName);
  // Get provider configuration
  const providerConfig = (configJson.providers as Record<string, ProviderConfig | undefined>)[LLM_PROVIDER];

  // Create different model instances based on the provider type
  if (LLM_PROVIDER === 'openai') {
    // Check if API key exists
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not found');
    }

    // Create OpenAI configuration
    const opt: OpenAIProviderSettings = {
      apiKey: OPENAI_API_KEY,
      compatibility: providerConfig?.clientConfig?.compatibility
    };

    // If there is a custom base URL, add it to the configuration
    if (OPENAI_BASE_URL) {
      opt.baseURL = OPENAI_BASE_URL;
    }

    // Create and return OpenAI model
    return createOpenAI(opt)(config.model);
  }

  // Vertex AI provider configuration
  if (LLM_PROVIDER === 'vertex') {
    // Dynamically import Vertex AI SDK
    const createVertex = require('@ai-sdk/google-vertex').createVertex;
    // If it's a search grounding tool, enable search grounding functionality
    if (toolName === 'searchGrounding') {
      return createVertex({ project: process.env.GCLOUD_PROJECT, ...providerConfig?.clientConfig })(config.model, { useSearchGrounding: true });
    }
    // Otherwise return normal model
    return createVertex({ project: process.env.GCLOUD_PROJECT, ...providerConfig?.clientConfig })(config.model);
  }

  // Gemini provider configuration
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not found');
  }

  // If it's a search grounding tool, enable search grounding functionality
  if (toolName === 'searchGrounding') {
    return createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })(config.model, { useSearchGrounding: true });
  }
  // Otherwise return normal model
  return createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })(config.model);
}

// Validate required environment variables
if (LLM_PROVIDER === 'gemini' && !GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not found");
if (LLM_PROVIDER === 'openai' && !OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not found");
if (!JINA_API_KEY) throw new Error("JINA_API_KEY not found");

// Log all configurations
const configSummary = {
  // Provider configuration summary
  provider: {
    name: LLM_PROVIDER,
    model: LLM_PROVIDER === 'openai'
      ? configJson.models.openai.default.model
      : configJson.models.gemini.default.model,
    ...(LLM_PROVIDER === 'openai' && { baseUrl: OPENAI_BASE_URL })
  },
  // Search configuration summary
  search: {
    provider: SEARCH_PROVIDER
  },
  // Tool configuration summary
  tools: Object.fromEntries(
    Object.keys(configJson.models[LLM_PROVIDER === 'vertex' ? 'gemini' : LLM_PROVIDER].tools).map(name => [
      name,
      getToolConfig(name as ToolName)
    ])
  ),
  // Default configuration summary
  defaults: {
    stepSleep: STEP_SLEEP
  }
};

// Output configuration summary
console.log('Configuration Summary:', JSON.stringify(configSummary, null, 2));
