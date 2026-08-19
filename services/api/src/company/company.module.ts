import { Module } from '@nestjs/common';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';

/**
 * Read side of the company intelligence layer. The write side lives in
 * `services/company-data`, which is the only writer of these tables.
 */
@Module({
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
