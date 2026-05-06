declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    logger: {
      debug(message: string): void;
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
    resolvePath(path: string): string;
    registerTool(...args: any[]): void;
    registerHook?: (...args: any[]) => void;
    registerCli?: (...args: any[]) => void;
    registerService?: (...args: any[]) => void;
    registerMemoryCapability?: (...args: any[]) => void;
    registerMemoryRuntime?: (...args: any[]) => void;
    on(...args: any[]): void;
    runtime?: any;
    pluginConfig?: any;
    [key: string]: any;
  }
}
