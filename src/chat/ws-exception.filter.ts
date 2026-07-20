import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import { Socket } from "socket.io";
import { createWsErrorResponse } from "./ws-error-response";

@Catch()
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();
    const response = createWsErrorResponse(exception);

    this.logger.error(
      {
        event: "chat.websocket_error",
        socketId: client.id,
        code: response.code,
        error:
          exception instanceof Error ? exception.message : String(exception),
      },
      exception instanceof Error ? exception.stack : undefined,
    );

    client.emit("chat:error", response);
  }
}
