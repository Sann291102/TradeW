import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { CompanyService } from './company.service';

/**
 * Company identity for the research surface.
 *
 * Authenticated like every other product route — this is not public reference
 * data, it is a feature of the product. Read-only throughout: nothing here can
 * write, so ingestion remains the sole writer of the identity tables.
 */
@ApiTags('Company')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('company')
export class CompanyController {
  constructor(private readonly companies: CompanyService) {}

  /** Free-text search across name, symbol and ISIN. Exact matches rank first. */
  @Get('search')
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    // Clamped rather than trusted: an unbounded `take` from a query string is a
    // cheap way for a caller to ask for every company on every keystroke.
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
    return this.companies.search(q || '', capped);
  }

  /**
   * Resolve one identifier — name, symbol or ISIN — to one canonical company.
   *
   * Returns `{ company: null }` rather than 404 when nothing matches: "no
   * company answers to this string" is a normal answer to a lookup, and a 404
   * would make an ordinary miss indistinguishable from a broken route.
   */
  @Get('resolve')
  async resolve(@Query('q') q?: string) {
    return { company: await this.companies.resolve(q || '') };
  }

  /** Full identity record for one company. */
  @Get(':id')
  byId(@Param('id') id: string) {
    return this.companies.byId(id);
  }
}
