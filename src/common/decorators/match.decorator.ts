import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * 自定义验证器，用于检查两个字段是否匹配
 */
@ValidatorConstraint({ name: 'match', async: false })
export class MatchConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    // 获取要比较的属性名
    const relatedPropertyName = args.constraints[0];
    // 获取要比较的属性的值
    const relatedValue = (args.object as any)[relatedPropertyName];
    // 返回比较结果
    return value === relatedValue;
  }

  defaultMessage(args: ValidationArguments) {
    const relatedPropertyName = args.constraints[0];
    return `${relatedPropertyName} 和 ${args.property} 不匹配`;
  }
}

/**
 * 自定义装饰器，用于验证两个字段是否匹配
 * @param property 要匹配的属性名
 * @param validationOptions 验证选项
 */
export function Match(property: string, validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [property],
      validator: MatchConstraint,
    });
  };
}
