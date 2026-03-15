declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig: unknown;
    config?: unknown;
    logger: {
      info: (message: string) => void;
      warn: (message: string) => void;
      debug: (message: string) => void;
    };
    resolvePath(path: string): string;
    on(event: string, handler: (...args: any[]) => any, options?: Record<string, unknown>): void;
    registerHook(name: string, handler: (...args: any[]) => any, options?: Record<string, unknown>): void;
    registerCli(...args: any[]): void;
    registerService(...args: any[]): void;
    registerTool(...args: any[]): void;
  }
}
