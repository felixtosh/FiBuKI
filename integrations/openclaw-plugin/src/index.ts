/**
 * FiBuKI OpenClaw Plugin
 *
 * Dynamically loads tools from the FiBuKI API based on the user's plan.
 * Users authenticate with an API key generated in FiBuKI Settings.
 */

const API_BASE_URL = "https://fibuki.com";

// OpenClaw plugin API types
interface OpenClawApi {
  config: PluginConfig;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerAgentTool: (tool: AgentTool) => void;
  registerService: (service: Service) => void;
}

interface PluginConfig {
  apiKey?: string;
}

interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

interface Service {
  id: string;
  start: () => void;
  stop: () => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredFeature?: string;
}

/**
 * Call the FiBuKI MCP API
 */
async function callApi(
  apiKey: string,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ tool, arguments: args }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return JSON.stringify(data.result, null, 2);
}

/**
 * Main plugin registration function
 *
 * Fetches available tools dynamically from the API based on the user's plan,
 * then registers each tool with OpenClaw.
 */
export default async function register(api: OpenClawApi) {
  const { config, logger } = api;

  const apiKey = config.apiKey || process.env.FIBUKI_API_KEY;
  if (!apiKey) {
    logger.error(
      "FiBuKI requires an API key. Get one at: https://fibuki.com/clawhub-install"
    );
    return;
  }

  logger.info("FiBuKI plugin initializing...");

  try {
    const statusJson = await callApi(apiKey, "get_automation_status", {});
    const status = JSON.parse(statusJson);
    const { plan, availableTools } = status as {
      plan: string;
      availableTools: ToolDefinition[];
    };

    if (!availableTools || !Array.isArray(availableTools)) {
      logger.error("FiBuKI: API returned no tools. Check your API key and plan.");
      return;
    }

    for (const tool of availableTools) {
      api.registerAgentTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        handler: async (args) => {
          try {
            return await callApi(apiKey, tool.name, args);
          } catch (error) {
            const msg = error instanceof Error ? error.message : "Unknown error";
            return `Error: ${msg}`;
          }
        },
      });
    }

    logger.info(`FiBuKI: ${availableTools.length} tools loaded (${plan} plan)`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`FiBuKI: Failed to load tools — ${msg}`);
    logger.error("Check your API key and network. Setup guide: https://fibuki.com/clawhub-install");
  }
}

// Export plugin metadata
export const id = "fibuki";
export const name = "FiBuKI Tax Studio";
export const version = "0.1.9";
