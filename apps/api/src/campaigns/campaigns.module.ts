import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { RoutingModule } from '../routing/routing.module';
import { PartnersController } from './partners.controller';

@Module({ imports: [RoutingModule], controllers: [CampaignsController, PartnersController] })
export class CampaignsModule {}
