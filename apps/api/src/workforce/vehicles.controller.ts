import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VehicleQueryDto } from './dto/query.dto';
import { ApiVehicleQuery } from './dto/query.swagger';
import {
  AuthorizedDriversResponseDto,
  PaginatedVehiclesDto,
  VehicleDto,
} from './dto/responses.dto';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { VehiclesService } from './vehicles.service';
import { toVehicleDto } from './workforce.mapper';

@ApiTags('workforce')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @ApiOperation({ summary: 'List vehicles' })
  @ApiVehicleQuery()
  @ApiResponse({ status: 200, type: PaginatedVehiclesDto })
  async list(@Query() query: VehicleQueryDto): Promise<PaginatedVehiclesDto> {
    const result = await this.vehicles.list(query);
    return { ...result, items: result.items.map(toVehicleDto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One vehicle' })
  @ApiResponse({ status: 200, type: VehicleDto })
  @ApiResponse({ status: 404, description: 'No such vehicle.' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.findOne(id));
  }

  @Get(':id/authorized-drivers')
  @ApiOperation({
    summary: 'Everyone authorised to drive this vehicle',
    description:
      'Straight from the workforce matrix checkmarks. Says nothing about who owns the vehicle or who usually drives it — the matrix does not record that.',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'Include deactivated employees. Defaults to false.',
  })
  @ApiResponse({ status: 200, type: AuthorizedDriversResponseDto })
  authorizedDrivers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AuthorizedDriversResponseDto> {
    return this.vehicles.authorizedDrivers(id, includeInactive === 'true');
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add a vehicle', description: 'Admin only.' })
  @ApiResponse({ status: 409, description: 'VEHICLE_CODE_TAKEN.' })
  @ApiResponse({ status: 201, type: VehicleDto })
  async create(
    @Body() dto: CreateVehicleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.create(dto, actor));
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a vehicle', description: 'Admin only.' })
  @ApiResponse({ status: 200, type: VehicleDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.update(id, dto, actor));
  }

  @Post(':id/deactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a vehicle',
    description: 'Admin only. Never deleted — published assignments reference it.',
  })
  @ApiResponse({ status: 201, type: VehicleDto })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.setActive(id, false, actor));
  }

  @Post(':id/reactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate a vehicle', description: 'Admin only.' })
  @ApiResponse({ status: 201, type: VehicleDto })
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.setActive(id, true, actor));
  }
}
