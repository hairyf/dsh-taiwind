import { Context } from "@deepseek-ai/cordis";
import { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { ClientModuleRegistry } from "@deepseek-ai/dsh-client-modules";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
//#region src/types.d.ts
type HostContext = Context & {
  clientModules: ClientModuleRegistry;
  webServer: WebServer;
  connection: HostConnectionHandle;
};
//#endregion
//#region src/index.d.ts
declare const name = "dsh-taiwindcss";
declare const inject: string[];
declare function apply(ctx: HostContext): Promise<void>;
//#endregion
export { apply, inject, name };