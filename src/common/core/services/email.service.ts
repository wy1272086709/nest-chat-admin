import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    // ✅ 依赖注入完成，但不在 constructor 中创建连接
  }

  async onModuleInit() {
    // ✅ 在生命周期钩子中初始化邮件传输器
    this.transporter = createTransport({
      host: this.configService.get<string>('email.host', 'smtp.qq.com'),
      port: this.configService.get<number>('email.port', 587),
      secure: this.configService.get<boolean>('email.secure', false),
      auth: {
        user: this.configService.get<string>('email.user'),
        pass: this.configService.get<string>('email.pass'),
      },
    });

    // 验证配置是否正确
    try {
      await this.transporter.verify();
      this.logger.log({ event: 'email.initialized' });
    } catch (error) {
      this.logger.error({ event: 'email.initialization_failed', err: error });
      // 不抛出错误，允许应用继续运行
    }
  }

  async sendMail(options: {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    from?: {
      name: string;
      address: string;
    };
  }): Promise<void> {
    const defaultFrom = {
      name: this.configService.get<string>('app.name', '考试系统'),
      address: this.configService.get<string>('email.user'),
    };

    await this.transporter.sendMail({
      from: options.from || defaultFrom,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }

  // 便捷方法：发送 HTML 邮件
  async sendHtmlMail(to: string | string[], subject: string, html: string): Promise<void> {
    return this.sendMail({ to, subject, html });
  }

  // 便捷方法：发送纯文本邮件
  async sendTextMail(to: string | string[], subject: string, text: string): Promise<void> {
    return this.sendMail({ to, subject, text });
  }

  generateVerificationCode(length = 6): string {
    return Math.random().toString(36).substring(2, length + 2);
  }

  // 便捷方法：发送验证码邮件
  async sendVerificationCode(to: string, code: string, username?: string): Promise<void> {
    const subject = '邮箱验证码';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">邮箱验证码</h2>
        ${username ? `<p>尊敬的 <strong>${username}</strong>：</p>` : ''}
        <p>您的验证码是：</p>
        <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 3px; margin: 20px 0;">
          ${code}
        </div>
        <p>验证码有效期为 10 分钟，请尽快完成验证。</p>
        <p style="color: #999; font-size: 12px;">如果这不是您的操作，请忽略此邮件。</p>
      </div>
    `;

    return this.sendHtmlMail(to, subject, html);
  }

  // 便捷方法：发送欢迎邮件
  async sendWelcomeEmail(to: string, username?: string): Promise<void> {
    const subject = '欢迎注册';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">欢迎注册！</h2>
        ${username ? `<p>亲爱的 <strong>${username}</strong>：</p>` : ''}
        <p>感谢您注册我们的服务！</p>
        <p>您的账户已成功创建，现在可以开始使用所有功能。</p>
        <p>如有任何问题，请随时联系我们。</p>
        <p style="color: #999; font-size: 12px;">这是一封自动发送的邮件，请勿直接回复。</p>
      </div>
    `;

    return this.sendHtmlMail(to, subject, html);
  }

  // 健康检查：验证邮件传输器是否正常工作
  async healthCheck(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      this.logger.error({ event: 'email.health_check_failed', err: error });
      return false;
    }
  }
}
