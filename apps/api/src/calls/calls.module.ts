import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { RecordingsController } from './recordings.controller';
import { ReportsController } from './reports.controller';

@Module({ controllers: [CallsController, ReportsController, RecordingsController] })
export class CallsModule {}
