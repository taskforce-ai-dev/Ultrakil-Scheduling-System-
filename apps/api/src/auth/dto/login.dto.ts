import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@taskforceai.tech', format: 'email' })
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;

  @ApiProperty({ example: 'ultrakil-change-me', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  password!: string;
}
