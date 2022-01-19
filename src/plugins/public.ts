import { FastifyPluginAsync } from 'fastify';
import fastifyCors from 'fastify-cors';
import { ItemTagService } from 'graasp-item-tags';
import graaspPluginPublic, { PublicItemService, PublicItemTaskManager } from 'graasp-plugin-public';
import { publicPlugin as publicThumbnailsPlugin } from 'graasp-plugin-thumbnails';
import { publicPlugin as publicFileItemPlugin } from 'graasp-plugin-file-item';
import { publicPlugin as publicCategoriesPlugin } from 'graasp-plugin-categories';
import { publicPlugin as publicAppsPlugin } from 'graasp-apps';
import { publicPlugin as publicChatboxPlugin } from 'graasp-plugin-chatbox';
import { publicPlugin as publicSearchPlugin } from 'graasp-plugin-search';
import {
  APPS_JWT_SECRET,
  APP_ITEMS_PREFIX,
  AVATARS_PATH_PREFIX,
  FILES_PATH_PREFIX,
  FILE_ITEM_PLUGIN_OPTIONS,
  GRAASP_ACTOR,
  ITEMS_ROUTE_PREFIX,
  PUBLIC_ROUTE_PREFIX,
  PUBLIC_TAG_ID,
  PUBLISHED_TAG_ID,
  S3_FILE_ITEM_PLUGIN_OPTIONS,
  SERVICE_METHOD,
  THUMBNAILS_PATH_PREFIX,
} from '../util/config';

export interface PublicPluginOptions {
  uri?: string;
  logs?: boolean;
}

const plugin: FastifyPluginAsync<PublicPluginOptions> = async (instance) => {
  const {
    items: { dbService: iS },
  } = instance;
  const itemTagService = new ItemTagService();
  const pIS = new PublicItemService(PUBLIC_TAG_ID);
  const pTM = new PublicItemTaskManager(pIS, iS, itemTagService, PUBLIC_TAG_ID);

  instance.decorate('public', {
    items: { taskManager: pTM, dbService: pIS },
    publishedTagId: PUBLISHED_TAG_ID,
    publicTagId: PUBLIC_TAG_ID,
    graaspActor: GRAASP_ACTOR,
  });

  // apps
  await instance.register(publicAppsPlugin, {
    jwtSecret: APPS_JWT_SECRET,
    prefix: `${PUBLIC_ROUTE_PREFIX}${APP_ITEMS_PREFIX}`,
  });

  await instance.register(
    async function (instance) {
      // add CORS support
      if (instance.corsPluginOptions) {
        instance.register(fastifyCors, instance.corsPluginOptions);
      }

      // items, members, item memberships
      await instance.register(graaspPluginPublic);

      // item thumbnail, member avatar endpoints
      await instance.register(publicThumbnailsPlugin, {
        serviceMethod: SERVICE_METHOD,
        prefixes: {
          avatarsPrefix: AVATARS_PATH_PREFIX,
          thumbnailsPrefix: THUMBNAILS_PATH_PREFIX,
        },
        serviceOptions: {
          s3: S3_FILE_ITEM_PLUGIN_OPTIONS,
          local: FILE_ITEM_PLUGIN_OPTIONS,
        },
      });

      // files
      instance.register(
        async () => {
          await instance.register(publicFileItemPlugin, {
            shouldLimit: true,
            pathPrefix: FILES_PATH_PREFIX,
            serviceMethod: SERVICE_METHOD,
            serviceOptions: {
              s3: S3_FILE_ITEM_PLUGIN_OPTIONS,
              local: FILE_ITEM_PLUGIN_OPTIONS,
            },
          });

          // categories
          await instance.register(publicCategoriesPlugin);

          // keyword search
          await instance.register(publicSearchPlugin);

          // chatbox
          await instance.register(publicChatboxPlugin);
        },
        { prefix: ITEMS_ROUTE_PREFIX },
      );
    },
    { prefix: PUBLIC_ROUTE_PREFIX },
  );
};

export default plugin;
