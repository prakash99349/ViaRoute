import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { ReportsController } from './reports.controller';

@Module({ controllers: [CallsController, ReportsController] })
export class CallsModule {}
