const SNOWFLAKE = /^\d{17,20}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_CLIENT = /^[\w-]+\.apps\.googleusercontent\.com$/;

export const DESTINATIONS = ['onedrive', 'google-drive'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export interface Config {
  discordToken: string;
  logChannelId: string;
  dataDir: string;
  oneDrive: { tenantId: string; clientId: string; root: string } | null;
  googleDrive: { clientId: string; clientSecret: string; root: string } | null;
}

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

// `destination` is null for commands that never upload, such as `capture`.
export function loadConfig(env: NodeJS.ProcessEnv, destination: Destination | null): Config {
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
    dataDir: read('ARCHIVER_DATA_DIR'),
    oneDrive:
      destination === 'onedrive'
        ? {
            tenantId: read('GRAPH_TENANT_ID', GUID),
            clientId: read('GRAPH_CLIENT_ID', GUID),
            root: read('ONEDRIVE_ROOT').replace(/^\/+|\/+$/g, ''),
          }
        : null,
    googleDrive:
      destination === 'google-drive'
        ? {
            clientId: read('GOOGLE_CLIENT_ID', GOOGLE_CLIENT),
            clientSecret: read('GOOGLE_CLIENT_SECRET'),
            root: read('GOOGLE_DRIVE_ROOT'),
          }
        : null,
  };

  if (problems.length > 0) throw new Error(`Config: ${problems.join('; ')}`);
  return config;
}
