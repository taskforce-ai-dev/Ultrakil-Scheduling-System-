import { registerDecorator, ValidationOptions } from 'class-validator';

/** A real calendar date, without a time or timezone suffix. */
export function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isDateOnly',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
          const date = new Date(`${value}T00:00:00.000Z`);
          return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
        },
        defaultMessage: () => `${propertyKey.toString()} must be a valid YYYY-MM-DD date`,
      },
    });
  };
}
