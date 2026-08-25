import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class AuthenticatedUserDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'admin@taskforceai.tech' })
  email!: string;

  @ApiProperty({ type: String, example: 'UltraKIL Administrator' })
  fullName!: string;

  @ApiProperty({
    type: String,
    enum: Object.values(UserRole),
    example: UserRole.MANAGER,
  })
  role!: UserRole;
}

export class LoginResponseDto {
  @ApiProperty({
    type: String,
    description: 'Send as `Authorization: Bearer <token>` on every request.',
  })
  accessToken!: string;

  @ApiProperty({ type: String, example: '12h' })
  expiresIn!: string;

  @ApiProperty({ type: AuthenticatedUserDto })
  user!: AuthenticatedUserDto;
}
