# class-validator 自定义校验器指南：从 @Match 到异步/灵活校验

> 关联代码：[src/common/validation/decorators/match.decorator.ts](../src/common/validation/decorators/match.decorator.ts)
> 实际使用：[src/user/dto/user.dto.ts](../src/user/dto/user.dto.ts)（`CreateUserDto.confirmPassword`、`ForgetPasswordDto.confirmPassword`）
> 技术栈：NestJS 11 + class-validator 0.15.1 + class-transformer 0.5.1

---

## 一、先看懂现在的 `@Match`：逐行拆解

`@Match` 由两块组成：**约束类**（真正干活的校验逻辑）+ **装饰器工厂**（把约束挂到 DTO 字段上的胶水）。

### 1.1 约束类 `MatchConstraint`

```ts
@ValidatorConstraint({ name: 'match', async: false })
export class MatchConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    const relatedPropertyName = args.constraints[0];          // 装饰器传入的参数，例如 'password'
    const relatedValue = (args.object as any)[relatedPropertyName]; // 从整个 DTO 实例里取对面那个字段的值
    return value === relatedValue;                             // 相等→通过
  }

  defaultMessage(args: ValidationArguments) {
    const relatedPropertyName = args.constraints[0];
    return `${relatedPropertyName} 和 ${args.property} 不匹配`; // 失败时的错误文案
  }
}
```

逐点说明：

| 元素 | 作用 |
|---|---|
| `@ValidatorConstraint({ name, async })` | 把这个类注册成一个"可被装饰器引用的校验器"。`name` 是元数据里的标识；`async: false` 声明它是**同步**校验（返回 `boolean`，不是 `Promise`）。 |
| `implements ValidatorConstraintInterface` | 强制实现 `validate()` 和 `defaultMessage()` 两个方法。 |
| `validate(value, args)` | `value` = 当前被装饰字段的值（如 `confirmPassword`）；`args` = 上下文。返回 `true` 通过，`false` 失败。 |
| `args.constraints` | **装饰器传进来的参数数组**。`@Match('password')` → `constraints[0] === 'password'`。这是装饰器向校验逻辑传参的唯一通道。 |
| `args.object` | **整个 DTO 实例**。靠它才能跨字段读到 `password` 的值——这是"两字段比对"能成立的关键。 |
| `args.property` | 当前字段名（`'confirmPassword'`），用于拼错误文案。 |
| `defaultMessage(args)` | 校验失败时生成消息。如果装饰器里用 `{ message: '...' }` 显式指定过，会覆盖这里的默认消息。 |

### 1.2 装饰器工厂 `Match`

```ts
export function Match(property: string, validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,   // DTO 类
      propertyName,                  // 被装饰的字段（confirmPassword）
      options: validationOptions,    // { message } 等，透传给 class-validator
      constraints: [property],       // 关键：把 'password' 放进数组，校验时通过 args.constraints[0] 取出
      validator: MatchConstraint,    // 绑定到上面那个约束类
    });
  };
}
```

- 它是**工厂**：`Match('password')` 先执行，返回一个真正的装饰器函数；装饰器函数再被 TS 在类定义时调用。
- `registerDecorator` 是 class-validator 暴露的底层 API，把"哪个类、哪个字段、用什么校验器、带什么参数"这套元数据登记进去。**装饰器本身不执行校验**，只是声明。

### 1.3 完整执行链路

```
客户端 POST /users { password, confirmPassword, ... }
        │
        ▼
Controller 方法参数 @Body() dto: CreateUserDto
        │  NestJS 全局 ValidationPipe 接管（见 app.module.ts 的 APP_PIPE）
        ▼
1) plainToClass：把普通 JSON 转成 CreateUserDto 实例（transform:true 生效）
2) class-validator 扫描该实例上所有装饰器元数据，逐字段校验
        │
        ▼
轮到 confirmPassword：
   - 先跑 @IsNotEmpty / @IsString（基础校验）
   - 再跑 @Match('password') → 调用 MatchConstraint.validate()
        │  取 args.object.password 与 value(confirmPassword) 比对
        ▼
3) 任何一项失败 → 收集成 ValidationError[]
4) exceptionFactory（app.module.ts 自定义）→ 取第一条消息 → 抛 BadRequestException
```

> 顺序提醒：同一个字段上的多个装饰器，**基础校验（非空/类型）建议写在 `@Match` 之前**。否则 `password` 为空时 `@Match` 也会跑，虽然结果仍是失败，但错误消息可能不是你想要的"不能为空"。

### 1.4 用真实请求看效果

以 `CreateUserDto` 为例，字段定义大致是这样：

```ts
@ApiProperty({ description: 'Password' })
@IsNotEmpty()
@IsString({ message: '密码不能为空' })
@MinLength(6, { message: '密码长度不能小于 6 个字符' })
password: string;

@ApiProperty({ description: 'Confirm Password' })
@IsNotEmpty()
@IsString({ message: '确认密码不能为空' })
@Match('password', { message: '确认密码和密码不一致' })
confirmPassword: string;
```

一次失败请求：

```bash
curl -X POST http://localhost:3000/api/users/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username":"alice",
    "email":"alice@example.com",
    "nickname":"Alice",
    "password":"123456",
    "confirmPassword":"654321",
    "code":"000000"
  }'
```

`confirmPassword` 字段进入 `@Match('password')` 时：

| 值 | 实际内容 |
|---|---|
| `value` | `"654321"`，也就是当前字段 `confirmPassword` 的值 |
| `args.constraints[0]` | `"password"`，来自 `@Match('password')` 的参数 |
| `(args.object as any).password` | `"123456"`，从整个 DTO 实例读取到的密码字段 |
| `validate()` 返回 | `false`，因为两者不相等 |

本项目 `ValidationPipe.exceptionFactory` 会取第一条校验消息，所以响应会类似：

```jsonc
{
  "statusCode": 400,
  "message": "确认密码和密码不一致",
  "error": "Bad Request"
}
```

一次成功请求只需要让两个字段一致：

```jsonc
{
  "password": "123456",
  "confirmPassword": "123456"
}
```

这时 `@Match` 返回 `true`，校验链继续往后走，Controller 才会进入真正的注册逻辑。

---

## 二、核心机制：为什么能这么写

理解三点，后面所有进阶写法都是它们的延伸：

1. **装饰器 = 元数据声明，不是执行**。`@IsEmail`、`@Match` 都只是在类上贴标签。真正校验由 `ValidationPipe` 在请求入口触发 `class-validator` 完成。
2. **`args.object` 是跨字段校验的唯一入口**。任何"看其他字段"的需求（A 必须 > B、A 和 B 不能同时为空、三选一）都从这里取值。
3. **`args.constraints` 是参数化校验器的通道**。把校验器写成"通用规则 + 参数"，就能复用（`@Match('password')`、`@Match('email')` 用同一套代码）。

---

## 三、进阶一：异步校验（请求后端 / 查库）

这是你最关心的场景：校验逻辑需要**等一个异步结果**——查数据库（邮箱是否已注册）、调外部接口（手机号实名、敏感词、邀请码是否有效）。

### 3.1 两个必改之处

```ts
@ValidatorConstraint({ name: 'isUserNotExist', async: true })  // ① async: true
export class IsUserNotExistConstraint implements ValidatorConstraintInterface {
  constructor(private readonly userService: UserService) {}     // ② 注入依赖（见 3.3 前置配置）

  async validate(value: any, args: ValidationArguments): Promise<boolean> {  // 返回 Promise
    const user = await this.userService.findByEmail(value);
    return !user; // 不存在 → 通过
  }

  defaultMessage() {
    return '该邮箱已被注册';
  }
}
```

变化只有两点：

1. `@ValidatorConstraint({ async: true })`：声明异步，class-validator 会 `await` 你的 `validate`。
2. `validate` 返回 `Promise<boolean>`：里面可以 `await` 任意异步操作（Prisma、`HttpService`、`fetch`）。

### 3.2 例子 A：注册时校验邮箱未被占用（查库）

> 直接套用项目里已有的 `CreateUserDto`，给 `email` 加一个"唯一性"异步校验。

```ts
// src/common/validation/decorators/is-user-not-exist.decorator.ts
import {
  registerDecorator, ValidationOptions, ValidatorConstraint,
  ValidatorConstraintInterface, ValidationArguments,
} from 'class-validator';
import { Injectable } from '@nestjs/common';
import { UserService } from '@/user/services/user.service';

@ValidatorConstraint({ name: 'isUserNotExist', async: true })
@Injectable()                                              // ← 让 Nest 容器能实例化它，从而注入 UserService
export class IsUserNotExistConstraint implements ValidatorConstraintInterface {
  constructor(private readonly userService: UserService) {}

  async validate(email: string, _args: ValidationArguments): Promise<boolean> {
    const existed = await this.userService.findByEmail(email); // 按你 service 里的实际方法名替换
    return !existed;
  }

  defaultMessage() {
    return '该邮箱已被注册';
  }
}

export function IsUserNotExist(validationOptions?: ValidationOptions) {
  return (object: Object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsUserNotExistConstraint,
    });
  };
}
```

DTO 里使用：

```ts
// src/user/dto/user.dto.ts
@ApiProperty({ description: 'Email address' })
@IsNotEmpty()
@IsEmail({}, { message: '请输入有效的邮箱地址' })
@IsUserNotExist({ message: '该邮箱已被注册' })   // ← 异步校验
email: string;
```

把这个例子落到项目里时，文件和改动点可以按下面这张表理解：

| 文件 | 要做什么 |
|---|---|
| `src/common/validation/decorators/is-user-not-exist.decorator.ts` | 放约束类 `IsUserNotExistConstraint` 和装饰器工厂 `IsUserNotExist()` |
| `src/user/dto/user.dto.ts` | 在 `CreateUserDto.email` 上追加 `@IsUserNotExist(...)` |
| `src/main.ts` | 加 `useContainer(app.select(AppModule), { fallbackOnErrors: true })`，让约束类能注入 `UserService` |
| 对应 module 的 `providers` | 注册 `IsUserNotExistConstraint`，否则 Nest 不知道这个 provider |

请求效果也很直观。假设数据库里已经有 `alice@example.com`：

```bash
curl -X POST http://localhost:3000/api/users/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username":"alice2",
    "email":"alice@example.com",
    "nickname":"Alice2",
    "password":"123456",
    "confirmPassword":"123456",
    "code":"000000"
  }'
```

校验过程是：

1. `@IsNotEmpty()` 先确认邮箱不为空。
2. `@IsEmail()` 再确认格式像邮箱。
3. `@IsUserNotExist()` 才调用 `userService.findByEmail(email)` 查库。
4. 查到用户，`validate()` 返回 `false`。
5. `exceptionFactory` 抛出第一条错误消息。

响应示例：

```jsonc
{
  "statusCode": 400,
  "message": "该邮箱已被注册",
  "error": "Bad Request"
}
```

如果邮箱不存在，`findByEmail()` 返回 `null`，`validate()` 返回 `true`，请求继续进入注册业务逻辑。

### 3.3 ⚠️ 前置配置：让约束类能注入 Nest Service（本项目当前缺这一步）

class-validator 默认**不经过 Nest 容器**，所以 `@Injectable()` 的约束类拿不到 `UserService`。必须在 [main.ts](../src/main.ts) 里加一行 `useContainer`，让它和 Nest 共用一个 DI 容器：

```ts
// main.ts
import { useContainer } from 'class-validator';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  useContainer(app.select(AppModule), { fallbackOnErrors: true }); // ← 加这一行
  await app.listen(3000);
}
bootstrap();
```

> 本项目 `grep useContainer src/` 当前为空，意味着**没开**。不开的话上面的注入会报 `Nest can't resolve dependencies of IsUserNotExistConstraint (UserService, ...)`。这是异步业务校验最容易踩的坑。

### 3.4 例子 B：调用外部 HTTP 接口校验（手机号实名 / 敏感词 / 邀请码）

项目装了 `@nestjs/axios`，可以用 `HttpService`。先在对应 Module 里 `HttpModule.forRoot(...)`，再注入：

```ts
@ValidatorConstraint({ name: 'isValidInviteCode', async: true })
@Injectable()
export class IsValidInviteCodeConstraint implements ValidatorConstraintInterface {
  constructor(private readonly httpService: HttpService) {}

  async validate(code: string): Promise<boolean> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(`https://invite.example.com/check?code=${encodeURIComponent(code)}`),
      );
      return data?.valid === true;
    } catch {
      // 外部接口挂了：默认拒绝，还是默认通过？取决于业务。
      // 安全敏感场景（邀请码）建议 return false；非关键场景可 return true 避免阻断主流程。
      return false;
    }
  }

  defaultMessage() {
    return '邀请码无效';
  }
}
```

完整装饰器工厂可以照这个写：

```ts
export function IsValidInviteCode(validationOptions?: ValidationOptions) {
  return (object: Object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidInviteCodeConstraint,
    });
  };
}
```

DTO 使用示例：

```ts
export class RegisterByInviteDto {
  @IsString({ message: '邀请码必须是字符串' })
  @IsValidInviteCode({ message: '邀请码无效或已过期' })
  inviteCode: string;
}
```

请求失败时，外部接口返回 `{ valid: false }`，或者校验器选择在接口异常时 `return false`，最终都会得到类似：

```jsonc
{
  "statusCode": 400,
  "message": "邀请码无效或已过期",
  "error": "Bad Request"
}
```

> `firstValueFrom` 来自 `rxjs`，是把 `HttpService`（基于 Observable）转成 Promise 的标准写法。

### 3.5 异步校验的坑（务必知道）

| 坑 | 说明 / 对策 |
|---|---|
| **性能** | 异步校验每个请求都查库/发 HTTP。高频接口要加缓存（Redis），或只在确实需要时才放在 DTO 层。 |
| **`forbidNonWhitelisted` 与异步顺序** | 本项目 `ValidationPipe` 开了 `whitelist + forbidNonWhitelisted + transform`。class-validator 会**先跑同步校验**，同步全过后才进入异步——这是好事，能避免无意义的查库（比如邮箱格式都不对，就不会去查唯一性）。 |
| **超时 / 容错** | 外部 API 必须设超时（`HttpModule` 配 `timeout`），否则恶意请求能拖垮服务。 |
| **N+1** | 批量场景下，逐条异步校验会很慢。DTO 层校验适合"单条创建"，批量校验更适合放到 service 层一次性处理。 |
| **唯一性竞态** | "邮箱未被注册"校验通过 ≠ 写入时仍可用（并发）。DTO 层异步校验只做体验优化，**唯一性最终要靠数据库 unique 约束兜底**。 |

---

## 四、进阶二：更灵活的自定义校验

异步只是"能不能等结果"的问题；"灵活"指的是**怎么把校验器设计得通用、可组合、可传参**。

### 4.1 轻量写法：`@Validate` 直接挂约束类，省掉装饰器工厂

如果某个约束只在一两处用，不必写 `registerDecorator` 工厂，class-validator 内置的 `@Validate` 直接可用：

```ts
import { Validate } from 'class-validator';

export class SomeDto {
  @Validate(MatchConstraint, ['password'], { message: '两次密码不一致' })
  //            ↑约束类       ↑constraints  ↑options
  confirmPassword: string;
}
```

`@Match` 装饰器工厂本质就是对 `@Validate(MatchConstraint, [property])` 的语义化包装。**写工厂是为了调用方代码读起来更顺**（`@Match('password')` 比 `@Validate(MatchConstraint, ['password'])` 清晰），不是技术必需。

### 4.2 参数化校验器：一个约束吃多种规则

把规则参数通过 `constraints` 传进去，校验器内部分支处理。下面这个"密码强度"校验器可以按需开关多种规则：

```ts
@ValidatorConstraint({ name: 'passwordPolicy', async: false })
export class PasswordPolicyConstraint implements ValidatorConstraintInterface {
  validate(value: string, args: ValidationArguments): boolean {
    const rules = args.constraints[0] as { min?: number; needDigit?: boolean; needSymbol?: boolean };
    if (typeof value !== 'string') return false;
    if (rules.min && value.length < rules.min) return false;
    if (rules.needDigit && !/\d/.test(value)) return false;
    if (rules.needSymbol && !/[!@#$%^&*]/.test(value)) return false;
    return true;
  }

  defaultMessage(args: ValidationArguments) {
    return `密码不符合策略要求`;
  }
}

export function PasswordPolicy(rules: Record<string, unknown>, opts?: ValidationOptions) {
  return (object: Object, propertyName: string) =>
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: opts,
      constraints: [rules],   // 把整份规则作为参数传进去
      validator: PasswordPolicyConstraint,
    });
}
```

DTO 里调用：

```ts
@PasswordPolicy({ min: 8, needDigit: true, needSymbol: true }, { message: '密码至少8位且含数字和特殊符号' })
password: string;
```

### 4.3 跨字段组合校验（"二选一"、"三选一"、"互斥"）

`@Match` 用 `args.object` 读对面字段。同一思路可做任意组合：

```ts
@ValidatorConstraint({ name: 'eitherOf', async: false })
export class EitherOfConstraint implements ValidatorConstraintInterface {
  validate(_value: any, args: ValidationArguments): boolean {
    const other = args.constraints[0] as string;
    const obj = args.object as Record<string, unknown>;
    // 当前字段或对面字段，至少有一个非空
    return Boolean(obj[args.property]) || Boolean(obj[other]);
  }
  defaultMessage(args: ValidationArguments) {
    return `${args.property} 与 ${args.constraints[0]} 至少填写一项`;
  }
}
export const EitherOf = (other: string, opts?: ValidationOptions) =>
  (object: Object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: opts,
      constraints: [other],
      validator: EitherOfConstraint,
    });
  };
```

具体使用场景：用户可以用 `email` 或 `phone` 任选一个作为联系方式。

```ts
export class ContactDto {
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @EitherOf('phone', { message: '邮箱和手机号至少填写一项' })
  email?: string;

  @IsOptional()
  @IsString({ message: '手机号必须是字符串' })
  phone?: string;
}
```

请求体为空时：

```jsonc
{}
```

`email` 字段上的 `@EitherOf('phone')` 会看到 `obj.email` 和 `obj.phone` 都为空，于是返回 `false`，响应类似：

```jsonc
{
  "statusCode": 400,
  "message": "邮箱和手机号至少填写一项",
  "error": "Bad Request"
}
```

下面两种都能通过这个组合校验：

```jsonc
{ "email": "alice@example.com" }
```

```jsonc
{ "phone": "13800138000" }
```

### 4.4 把校验逻辑放进 Service（最灵活，但跳出装饰器体系）

当校验**强依赖业务上下文**（当前用户、事务、多表关联）时，硬塞进 class-validator 不划算。更干净的分层：

```ts
// DTO 只保留"格式"校验（同步、无依赖）
export class CreateOrderDto {
  @IsNumber()
  @Min(1)
  quantity: number;
  @IsString()
  couponCode?: string;
}

// 业务校验放 Service，在 controller/service 里显式调用
async create(dto: CreateOrderDto, userId: string) {
  if (dto.couponCode) {
    const ok = await this.couponService.validate(dto.couponCode, userId);
    if (!ok) throw new BadRequestException('优惠券不可用');
  }
  // ... 业务逻辑
}
```

**选择标准**：

| 场景 | 推荐做法 |
|---|---|
| 纯格式 / 字段间关系（邮箱格式、两次密码一致） | DTO 装饰器（同步） |
| 单字段 + 需查库/调接口（邮箱唯一、邀请码有效） | DTO 异步装饰器（`async: true`） |
| 强业务、多字段、依赖当前用户/事务 | Service 层手动校验 |

DTO 装饰器的好处是**集中、自动、可复用**；Service 校验的好处是**上下文全、可测试、不污染 DTO**。两者不互斥，按规则性质分层即可。

---

## 五、回到本项目：落地清单

如果要让本项目支持"后端请求/查库校验"，按顺序做：

1. **[main.ts](../src/main.ts)** 加 `useContainer(app.select(AppModule), { fallbackOnErrors: true })` —— 没这步，所有需要注入 Service 的异步约束都跑不起来。
2. 在 [src/common/validation/decorators/](../src/common/validation/decorators/) 下新建约束类（参考 3.2），用 `@Injectable()` 标注。
3. 对应 Module 的 `providers` 里**注册约束类**（或保证它依赖的 Service 在该 Module 可注入）。
4. DTO 字段上挂装饰器，配合全局 `ValidationPipe` 的 `exceptionFactory` 自动返回 `400 + 第一条错误消息`。

> ⚠️ 别忘了 3.5 的"唯一性竞态"：DTO 层异步校验只是体验优化，数据库 `unique` 约束才是最终防线。

---

## 附：关键 API 速查

| API | 作用 |
|---|---|
| `registerDecorator({...})` | 把约束类挂到字段上，装饰器工厂的核心 |
| `ValidatorConstraintInterface` | 约束类接口，需实现 `validate` + `defaultMessage` |
| `@ValidatorConstraint({ name, async })` | 标记约束类，`async` 决定是否支持 Promise |
| `ValidationArguments.constraints` | 装饰器传入的参数数组 |
| `ValidationArguments.object` | 整个 DTO 实例（跨字段访问） |
| `ValidationArguments.property` | 当前字段名 |
| `@Validate(Constraint, [args], options)` | 不写工厂时的轻量替代 |
| `useContainer(app.select(AppModule), { fallbackOnErrors: true })` | 让约束类能注入 Nest Service 的前提 |
