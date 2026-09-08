import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { z } from 'zod';

import { Public } from '../../auth/decorators/public.decorator';
import { ScheduleRunService } from './schedule-run.service';

interface QStashReceiver {
  verify(input: {
    signature: string;
    body: string;
    url: string;
  }): Promise<boolean>;
}

type QStashReceiverConstructor = new (options: {
  currentSigningKey: string;
  nextSigningKey: string;
}) => QStashReceiver;

function createReceiver(config: ConfigService): QStashReceiver {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Receiver } = require('@upstash/qstash') as {
    Receiver: QStashReceiverConstructor;
  };
  return new Receiver({
    currentSigningKey: config.getOrThrow<string>(
      'scheduleDispatch.qstash.currentSigningKey',
    ),
    nextSigningKey: config.getOrThrow<string>(
      'scheduleDispatch.qstash.nextSigningKey',
    ),
  });
}

const executePayload = z.object({ runId: z.string().uuid() }).strict();
const failurePayload = z
  .object({
    sourceMessageId: z.string().min(1),
    sourceBody: z.string().min(1),
    status: z.number(),
  })
  .passthrough();

/** QStash-only routes. The public controller stays provider-neutral. */
@Controller('internal/schedule-runs')
export class ScheduleRunQStashController {
  private readonly receiver: QStashReceiver;

  constructor(
    private readonly runs: ScheduleRunService,
    private readonly config: ConfigService,
    receiver?: QStashReceiver,
  ) {
    this.receiver = receiver ?? createReceiver(config);
  }

  @Post('execute')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async execute(@Req() request: RawBodyRequest<Request>): Promise<void> {
    const raw = await this.verify(request, 'scheduleDispatch.executeUrl');
    const payload = this.parseExecutePayload(raw);
    const outcome = await this.runs.deliver(payload.runId, {
      executionBudgetSeconds: this.config.getOrThrow<number>(
        'scheduleDispatch.executionBudgetSeconds',
      ),
      retryOnFailure: true,
    });
    // Returning 503 keeps this delivery retriable. A second worker must never
    // acknowledge an active lease, or a crashed owner would strand the run.
    if (outcome.kind === 'busy') {
      throw new ServiceUnavailableException(
        'Schedule run is already executing.',
      );
    }
  }

  @Post('failure')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async failure(@Req() request: RawBodyRequest<Request>): Promise<void> {
    const raw = await this.verify(request, 'scheduleDispatch.failureUrl');
    const callback = this.parseFailurePayload(raw);
    const source = this.parseExecutePayload(
      Buffer.from(callback.sourceBody, 'base64').toString('utf8'),
    );
    await this.runs.failForQStash(
      source.runId,
      callback.sourceMessageId,
      'QSTASH_DELIVERY_FAILED',
      `QStash exhausted delivery retries with HTTP ${callback.status}.`,
    );
  }

  private async verify(
    request: RawBodyRequest<Request>,
    destinationConfigKey:
      'scheduleDispatch.executeUrl' | 'scheduleDispatch.failureUrl',
  ): Promise<string> {
    const raw = request.rawBody?.toString('utf8');
    const signature = request.header('upstash-signature');
    if (!raw || !signature) {
      throw new UnauthorizedException(
        'Missing QStash signature or raw request body.',
      );
    }
    let valid = false;
    try {
      valid = await this.receiver.verify({
        signature,
        body: raw,
        url: this.config.getOrThrow<string>(destinationConfigKey),
      });
    } catch {
      // Treat SDK/key/JWT verification failures exactly like a bad signature.
      // These routes must never reveal signing-key or token details.
      throw new UnauthorizedException('Invalid QStash signature.');
    }
    if (!valid) throw new UnauthorizedException('Invalid QStash signature.');
    return raw;
  }

  private parseExecutePayload(raw: string): z.infer<typeof executePayload> {
    const parsed = executePayload.safeParse(this.parseJson(raw));
    if (!parsed.success)
      throw new BadRequestException('Invalid QStash run payload.');
    return parsed.data;
  }

  private parseFailurePayload(raw: string): z.infer<typeof failurePayload> {
    const parsed = failurePayload.safeParse(this.parseJson(raw));
    if (!parsed.success)
      throw new BadRequestException('Invalid QStash failure payload.');
    return parsed.data;
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new BadRequestException('Invalid QStash JSON payload.');
    }
  }
}
