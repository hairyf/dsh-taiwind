import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

export type HostContext = Context & {
  clientModules: ClientModuleRegistry
  webServer: WebServer
  connection: HostConnectionHandle
}
