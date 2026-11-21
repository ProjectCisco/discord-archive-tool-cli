const SNOWFLAKE = /^\d{17,20}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Config {
  discordToken: string;
  logChannelId: string;
  graphTenantId: string;
  graphClientId: string;
  oneDriveRoot: string;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  // Values are never echoed: DISCORD_TOKEN goes through here too.
  const read = (name: string, pattern?: RegExp): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') problems.push(`${name} is missing`);
    else if (pattern && !pattern.test(value)) problems.push(`${name} is not in the expected format`);
    return value;
  };

  const config: Config = {
    discordToken: read('DISCORD_TOKEN'),
    logChannelId: read('DISCORD_LOG_CHANNEL_ID', SNOWFLAKE),
    graphTenantId: read('GRAPH_TENANT_ID', GUID),
    graphClientId: read('GRAPH_CLIENT_ID', GUID),
    oneDriveRoot: read('ONEDRIVE_ROOT').replace(/^\/+|\/+$/g, ''),
    dataDir: read('ARCHIVER_DATA_DIR'),
  };

  if (problems.length > 0) throw new Error(`Config: ${problems.join('; ')}`);
  return config;
}
