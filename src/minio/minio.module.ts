import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as Minio from "minio";
import { MinioController } from "./minio.controller";

function getMinioCredentials(configService: ConfigService) {
  return {
    accessKey: configService.get<string>("minio.accessKey", "minioadmin"),
    secretKey: configService.get<string>("minio.secretKey", "minioadmin"),
  };
}

@Global()
@Module({
  providers: [
    {
      provide: "MINIO_CLIENT",
      useFactory(configService: ConfigService) {
        return new Minio.Client({
          endPoint: configService.get<string>("minio.endPoint", "localhost"),
          port: configService.get<number>("minio.port", 9000),
          useSSL: configService.get<boolean>("minio.useSSL", false),
          ...getMinioCredentials(configService),
        });
      },
      inject: [ConfigService],
    },
    {
      provide: "MINIO_PUBLIC_CLIENT",
      useFactory(configService: ConfigService) {
        const configuredUrl = configService.get<string>(
          "minio.publicServerUrl",
        );
        const url = configuredUrl ? new URL(configuredUrl) : undefined;
        return new Minio.Client({
          endPoint:
            url?.hostname ??
            configService.get<string>("minio.endPoint", "localhost"),
          port: url?.port
            ? Number(url.port)
            : configService.get<number>("minio.port", 9000),
          useSSL: url
            ? url.protocol === "https:"
            : configService.get<boolean>("minio.useSSL", false),
          ...getMinioCredentials(configService),
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ["MINIO_CLIENT", "MINIO_PUBLIC_CLIENT"],
  controllers: [MinioController],
})
export class MinioModule {}
