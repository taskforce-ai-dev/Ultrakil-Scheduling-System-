import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthenticatedUserDto, LoginResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Exchanges an email and password for an access token. Send the token as `Authorization: Bearer <token>` on every other endpoint.',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'Wrong email, wrong password, or a deactivated account — all return the same `INVALID_CREDENTIALS`, so the response cannot be used to discover which emails exist.',
  })
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Who am I',
    description:
      'Returns the signed-in user. Useful for the portal to restore a session and decide which actions to show.',
  })
  @ApiResponse({ status: 200, type: AuthenticatedUserDto })
  @ApiResponse({ status: 401, description: 'Missing, invalid or expired token.' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUserDto {
    return user;
  }
}
