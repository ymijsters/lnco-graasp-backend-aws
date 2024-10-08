import { Redis } from 'ioredis';
import { MeiliSearch } from 'meilisearch';

import { FastifyInstance } from 'fastify';

import Etherpad from '@graasp/etherpad-api';

import { CRON_3AM_MONDAY, JobServiceBuilder } from '../jobs';
import { BaseLogger } from '../logger';
import { MailerService } from '../plugins/mailer/service';
import FileService from '../services/file/service';
import { fileRepositoryFactory } from '../services/file/utils/factory';
import { wrapEtherpadErrors } from '../services/item/plugins/etherpad/etherpad';
import { RandomPadNameFactory } from '../services/item/plugins/etherpad/service';
import { EtherpadServiceConfig } from '../services/item/plugins/etherpad/serviceConfig';
import FileItemService from '../services/item/plugins/file/service';
import { H5PService } from '../services/item/plugins/html/h5p/service';
import { ImportExportService } from '../services/item/plugins/importExport/service';
import { PublicationService } from '../services/item/plugins/publication/publicationState/service';
import { MeiliSearchWrapper } from '../services/item/plugins/publication/published/plugins/search/meilisearch';
import { SearchService } from '../services/item/plugins/publication/published/plugins/search/service';
import { ValidationQueue } from '../services/item/plugins/publication/validation/validationQueue';
import { ItemService } from '../services/item/service';
import {
  FILE_ITEM_PLUGIN_OPTIONS,
  FILE_ITEM_TYPE,
  GEOLOCATION_API_KEY,
  IMAGE_CLASSIFIER_API,
  MAILER_CONFIG_FROM_EMAIL,
  MAILER_CONFIG_PASSWORD,
  MAILER_CONFIG_SMTP_HOST,
  MAILER_CONFIG_SMTP_PORT,
  MAILER_CONFIG_SMTP_USE_SSL,
  MAILER_CONFIG_USERNAME,
  MEILISEARCH_MASTER_KEY,
  MEILISEARCH_URL,
  REDIS_HOST,
  REDIS_PASSWORD,
  REDIS_PORT,
  REDIS_USERNAME,
  S3_FILE_ITEM_PLUGIN_OPTIONS,
} from '../utils/config';
import { buildRepositories } from '../utils/repositories';
import {
  ETHERPAD_NAME_FACTORY_DI_KEY,
  FASTIFY_LOGGER_DI_KEY,
  FILE_ITEM_TYPE_DI_KEY,
  FILE_REPOSITORY_DI_KEY,
  GEOLOCATION_API_KEY_DI_KEY,
  IMAGE_CLASSIFIER_API_DI_KEY,
} from './constants';
import { registerValue, resolveDependency } from './utils';

export const registerDependencies = (instance: FastifyInstance) => {
  const { log, db } = instance;

  console.log("In Register Dependencies");

  // register FastifyBasLogger as a value to allow BaseLogger to be injected automatically.
  registerValue(FASTIFY_LOGGER_DI_KEY, log);

  console.log("BaseLogger Dependency Succeeded");

  // register file type for the StorageService.
  registerValue(FILE_ITEM_TYPE_DI_KEY, FILE_ITEM_TYPE);

  console.log("StorageService Dependency Succeeded");

  // register classifier key for the ValidationService.
  registerValue(IMAGE_CLASSIFIER_API_DI_KEY, IMAGE_CLASSIFIER_API);

  console.log("Validation Service Classifier Key Dependency Succeeded");

  // register geolocation key for the ItemGeolocationService.
  registerValue(GEOLOCATION_API_KEY_DI_KEY, GEOLOCATION_API_KEY);

  console.log("Geolocation Dependency Succeeded");


  registerValue(
    Redis,
    new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      username: REDIS_USERNAME,
      password: REDIS_PASSWORD,
    }),
  );

  console.log("Redis Registered");

  registerValue(
    MailerService,
    new MailerService({
      host: MAILER_CONFIG_SMTP_HOST,
      port: MAILER_CONFIG_SMTP_PORT,
      useSsl: MAILER_CONFIG_SMTP_USE_SSL,
      username: MAILER_CONFIG_USERNAME,
      password: MAILER_CONFIG_PASSWORD,
      fromEmail: MAILER_CONFIG_FROM_EMAIL,
    }),
  );


  // register the interface FileRepository with the concrete repo returned by the factory.
  registerValue(
    FILE_REPOSITORY_DI_KEY,
    fileRepositoryFactory(FILE_ITEM_TYPE, {
      s3: S3_FILE_ITEM_PLUGIN_OPTIONS,
      local: FILE_ITEM_PLUGIN_OPTIONS,
    }),
  );


  // register MeiliSearch and its wrapper.
  registerValue(
    MeiliSearch,
    new MeiliSearch({
      host: MEILISEARCH_URL,
      apiKey: MEILISEARCH_MASTER_KEY,
    }),
  );

  // Will be registered automatically when db will be injectable.
  registerValue(
    MeiliSearchWrapper,
    new MeiliSearchWrapper(
      db,
      resolveDependency(MeiliSearch),
      resolveDependency(FileService),
      resolveDependency(BaseLogger),
    ),
  );

  registerValue(
    ImportExportService,
    new ImportExportService(
      db,
      resolveDependency(FileItemService),
      resolveDependency(ItemService),
      resolveDependency(H5PService),
      resolveDependency(BaseLogger),
    ),
  );

  console.log("ImportExport Service Registered");


  // Launch Job workers
  const jobServiceBuilder = new JobServiceBuilder(resolveDependency(BaseLogger));
  jobServiceBuilder
    .registerTask('rebuild-index', {
      handler: () => resolveDependency(SearchService).rebuildIndex(),
      pattern: CRON_3AM_MONDAY,
    })
    .build();

    console.log("JobServices Launched");


  // Register EtherPad
  const etherPadConfig = resolveDependency(EtherpadServiceConfig);

  console.log("Etherpad Dependency Resolved");


  // connect to etherpad server
  registerValue(
    Etherpad,
    wrapEtherpadErrors(
      new Etherpad({
        url: etherPadConfig.url,
        apiKey: etherPadConfig.apiKey,
        apiVersion: etherPadConfig.apiVersion,
      }),
    ),
  );

  console.log("Etherpad Service REgistered");


  registerValue(ETHERPAD_NAME_FACTORY_DI_KEY, new RandomPadNameFactory());

  console.log("Etherpad Value REgistered");


  // This code will be improved when we will be able to inject the repositories.
  const { itemTagRepository, itemValidationGroupRepository, itemPublishedRepository } =
    buildRepositories();
  registerValue(
    PublicationService,
    new PublicationService(
      resolveDependency(ItemService),
      itemTagRepository,
      itemValidationGroupRepository,
      itemPublishedRepository,
      resolveDependency(ValidationQueue),
    ),
  );

  console.log("Last STep Completed");

};
