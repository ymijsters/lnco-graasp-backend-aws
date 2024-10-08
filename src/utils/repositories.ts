import { EntityManager } from 'typeorm';

import { ActionRepository } from '../services/action/repositories/action';
import { MemberPasswordRepository } from '../services/auth/plugins/password/repository';
import { ChatMentionRepository } from '../services/chat/plugins/mentions/repository';
import { ChatMessageRepository } from '../services/chat/repository';
import { ActionRequestExportRepository } from '../services/item/plugins/action/requestExport/repository';
import { AppActionRepository } from '../services/item/plugins/app/appAction/repository';
import { AppDataRepository } from '../services/item/plugins/app/appData/repository';
import { AppSettingRepository } from '../services/item/plugins/app/appSetting/repository';
import { PublisherRepository } from '../services/item/plugins/app/publisherRepository';
import { AppRepository } from '../services/item/plugins/app/repository';
import { ItemGeolocationRepository } from '../services/item/plugins/geolocation/repository';
import { InvitationRepository } from '../services/item/plugins/invitation/repository';
import { CategoryRepository } from '../services/item/plugins/itemCategory/repositories/category';
import { ItemCategoryRepository } from '../services/item/plugins/itemCategory/repositories/itemCategory';
import { FavoriteRepository } from '../services/item/plugins/itemFavorite/repositories/favorite';
import { ItemFlagRepository } from '../services/item/plugins/itemFlag/repository';
import { ItemLikeRepository } from '../services/item/plugins/itemLike/repository';
import { ItemTagRepository } from '../services/item/plugins/itemTag/repository';
import { ItemPublishedRepository } from '../services/item/plugins/publication/published/repositories/itemPublished';
import { ItemValidationGroupRepository } from '../services/item/plugins/publication/validation/repositories/ItemValidationGroup';
import { ItemValidationRepository } from '../services/item/plugins/publication/validation/repositories/itemValidation';
import { ItemValidationReviewRepository } from '../services/item/plugins/publication/validation/repositories/itemValidationReview';
import { RecycledItemDataRepository } from '../services/item/plugins/recycled/repository';
import { ShortLinkRepository } from '../services/item/plugins/shortLink/repository';
import { ItemRepository } from '../services/item/repository';
import { ItemLoginRepository } from '../services/itemLogin/repositories/itemLogin';
import { ItemLoginSchemaRepository } from '../services/itemLogin/repositories/itemLoginSchema';
import { ItemMembershipRepository } from '../services/itemMembership/repository';
import MemberProfileRepository from '../services/member/plugins/profile/repository';
import { MemberRepository } from '../services/member/repository';

export type Repositories = {
  actionRepository: ActionRepository;
  actionRequestExportRepository: typeof ActionRequestExportRepository;
  appActionRepository: typeof AppActionRepository;
  appDataRepository: typeof AppDataRepository;
  appRepository: typeof AppRepository;
  appSettingRepository: typeof AppSettingRepository;
  categoryRepository: typeof CategoryRepository;
  chatMessageRepository: typeof ChatMessageRepository;
  invitationRepository: typeof InvitationRepository;
  itemCategoryRepository: typeof ItemCategoryRepository;
  itemFavoriteRepository: FavoriteRepository;
  itemFlagRepository: typeof ItemFlagRepository;
  itemLikeRepository: typeof ItemLikeRepository;
  itemLoginRepository: typeof ItemLoginRepository;
  itemLoginSchemaRepository: typeof ItemLoginSchemaRepository;
  itemMembershipRepository: typeof ItemMembershipRepository;
  itemPublishedRepository: ItemPublishedRepository;
  itemRepository: ItemRepository;
  itemTagRepository: ItemTagRepository;
  itemValidationGroupRepository: ItemValidationGroupRepository;
  itemValidationRepository: ItemValidationRepository;
  itemValidationReviewRepository: ItemValidationReviewRepository;
  memberPasswordRepository: MemberPasswordRepository;
  memberRepository: MemberRepository;
  mentionRepository: ChatMentionRepository;
  publisherRepository: typeof PublisherRepository;
  recycledItemRepository: typeof RecycledItemDataRepository;
  memberProfileRepository: MemberProfileRepository;
  shortLinkRepository: typeof ShortLinkRepository;
  itemGeolocationRepository: ItemGeolocationRepository;
};
// public: exists in item tag

export const buildRepositories = (manager?: EntityManager): Repositories => ({
  itemRepository: new ItemRepository(manager),
  itemMembershipRepository: manager
    ? manager.withRepository(ItemMembershipRepository)
    : ItemMembershipRepository,
  memberRepository: new MemberRepository(manager),

  itemPublishedRepository: new ItemPublishedRepository(manager),
  itemLoginRepository: manager ? manager.withRepository(ItemLoginRepository) : ItemLoginRepository,
  itemLoginSchemaRepository: manager
    ? manager.withRepository(ItemLoginSchemaRepository)
    : ItemLoginSchemaRepository,
  memberPasswordRepository: new MemberPasswordRepository(manager),
  appRepository: manager ? manager.withRepository(AppRepository) : AppRepository,
  appDataRepository: manager ? manager.withRepository(AppDataRepository) : AppDataRepository,
  appActionRepository: manager ? manager.withRepository(AppActionRepository) : AppActionRepository,
  appSettingRepository: manager
    ? manager.withRepository(AppSettingRepository)
    : AppSettingRepository,
  publisherRepository: manager ? manager.withRepository(PublisherRepository) : PublisherRepository,
  recycledItemRepository: manager
    ? manager.withRepository(RecycledItemDataRepository)
    : RecycledItemDataRepository,
  itemLikeRepository: manager ? manager.withRepository(ItemLikeRepository) : ItemLikeRepository,
  itemFlagRepository: manager ? manager.withRepository(ItemFlagRepository) : ItemFlagRepository,
  invitationRepository: manager
    ? manager.withRepository(InvitationRepository)
    : InvitationRepository,
  chatMessageRepository: manager
    ? manager.withRepository(ChatMessageRepository)
    : ChatMessageRepository,
  mentionRepository: new ChatMentionRepository(manager),
  itemCategoryRepository: manager
    ? manager.withRepository(ItemCategoryRepository)
    : ItemCategoryRepository,
  itemFavoriteRepository: new FavoriteRepository(manager),
  categoryRepository: manager ? manager.withRepository(CategoryRepository) : CategoryRepository,
  itemTagRepository: new ItemTagRepository(manager),
  itemValidationRepository: new ItemValidationRepository(manager),
  itemValidationReviewRepository: new ItemValidationReviewRepository(manager),
  itemValidationGroupRepository: new ItemValidationGroupRepository(manager),

  actionRepository: new ActionRepository(manager),
  actionRequestExportRepository: manager
    ? manager.withRepository(ActionRequestExportRepository)
    : ActionRequestExportRepository,
  memberProfileRepository: new MemberProfileRepository(manager),
  shortLinkRepository: manager ? manager.withRepository(ShortLinkRepository) : ShortLinkRepository,
  itemGeolocationRepository: new ItemGeolocationRepository(manager),
});
