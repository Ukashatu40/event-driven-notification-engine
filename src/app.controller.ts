import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './api/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Root liveness banner; nothing sensitive, so it stays reachable without a token.
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
