import { FastifyPluginAsync } from 'fastify';

import { resolveDependency } from '../../../../di/utils';
import { notUndefined } from '../../../../utils/assertions';
import { buildRepositories } from '../../../../utils/repositories';
import { isAuthenticated, optionalIsAuthenticated } from '../../../auth/plugins/passport';
import { matchOne } from '../../../authorization';
import { validatedMember } from '../../../member/strategies/validatedMember';
import { ItemFlag } from './itemFlag';
import common, { create, getFlags } from './schemas';
import { ItemFlagService } from './service';

const plugin: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  const itemFlagService = resolveDependency(ItemFlagService);

  // schemas
  fastify.addSchema(common);

  // get flags
  fastify.get(
    '/flags',
    { schema: getFlags, preHandler: optionalIsAuthenticated },
    async ({ user }) => {
      return itemFlagService.getAllFlags(user?.member, buildRepositories());
    },
  );

  // create item flag
  fastify.post<{ Params: { itemId: string }; Body: Partial<ItemFlag> }>(
    '/:itemId/flags',
    { schema: create, preHandler: [isAuthenticated, matchOne(validatedMember)] },
    async ({ user, params: { itemId }, body }) => {
      return db.transaction(async (manager) => {
        const member = notUndefined(user?.member);
        return itemFlagService.post(member, buildRepositories(manager), itemId, body);
      });
    },
  );
};

export default plugin;
