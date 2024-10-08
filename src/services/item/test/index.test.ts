import FormData from 'form-data';
import fs from 'fs';
import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import waitForExpect from 'wait-for-expect';

import { FastifyInstance } from 'fastify';

import {
  DescriptionPlacement,
  FolderItemFactory,
  HttpMethod,
  ItemTagType,
  ItemType,
  MAX_NUMBER_OF_CHILDREN,
  MAX_TARGETS_FOR_MODIFY_REQUEST,
  MAX_TREE_LEVELS,
  MemberFactory,
  PermissionLevel,
  buildPathFromIds,
} from '@graasp/sdk';

import build, { clearDatabase } from '../../../../test/app';
import { MULTIPLE_ITEMS_LOADING_TIME } from '../../../../test/constants';
import { AppDataSource } from '../../../plugins/datasource';
import {
  HierarchyTooDeep,
  ItemNotFolder,
  ItemNotFound,
  MemberCannotAccess,
  MemberCannotWriteItem,
  TooManyChildren,
} from '../../../utils/errors';
import { ItemMembershipRepository } from '../../itemMembership/repository';
import { Member } from '../../member/entities/member';
import { saveMember } from '../../member/test/fixtures/members';
import { PackedItem } from '../ItemWrapper';
import { Item } from '../entities/Item';
import { ItemGeolocation } from '../plugins/geolocation/ItemGeolocation';
import { ItemTag } from '../plugins/itemTag/ItemTag';
import { Ordering, SortBy } from '../types';
import {
  ItemTestUtils,
  expectItem,
  expectManyPackedItems,
  expectPackedItem,
} from './fixtures/items';

const rawRepository = AppDataSource.getRepository(ItemTag);

const testUtils = new ItemTestUtils();

// Mock S3 libraries
const deleteObjectMock = jest.fn(async () => console.debug('deleteObjectMock'));
const copyObjectMock = jest.fn(async () => console.debug('copyObjectMock'));
const headObjectMock = jest.fn(async () => ({ ContentLength: 10 }));
const uploadDoneMock = jest.fn(async () => console.debug('aws s3 storage upload'));
const MOCK_SIGNED_URL = 'signed-url';
jest.mock('@aws-sdk/client-s3', () => {
  return {
    GetObjectCommand: jest.fn(),
    S3: function () {
      return {
        copyObject: copyObjectMock,
        deleteObject: deleteObjectMock,
        headObject: headObjectMock,
      };
    },
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => {
  const getSignedUrl = jest.fn(async () => MOCK_SIGNED_URL);
  return {
    getSignedUrl,
  };
});
jest.mock('@aws-sdk/lib-storage', () => {
  return {
    Upload: jest.fn().mockImplementation(() => {
      return {
        done: uploadDoneMock,
      };
    }),
  };
});

const saveUntilMaxDescendants = async (parent: Item, actor: Member) => {
  // save maximum depth
  // TODO: DYNAMIC
  let currentParent = parent;
  for (let i = 0; i < MAX_TREE_LEVELS - 1; i++) {
    const newCurrentParent = await testUtils.saveItem({
      actor,
      parentItem: currentParent,
    });
    currentParent = newCurrentParent;
  }
  // return last child
  return currentParent;
};

const saveNbOfItems = async ({
  nb,
  actor,
  parentItem,
  member,
  item: itemData = {},
}: {
  member?: Member;
  nb: number;
  actor: Member;
  parentItem?: Item;
  item?: Partial<Item>;
}) => {
  const items: Item[] = [];
  for (let i = 0; i < nb; i++) {
    const { item } = await testUtils.saveItemAndMembership({
      item: { name: 'item ' + i, ...itemData },
      member: member ?? actor,
      parentItem,
      creator: actor,
    });
    items.push(item);
  }
  return items;
};

describe('Item routes tests', () => {
  let app: FastifyInstance;
  let actor;

  afterEach(async () => {
    jest.clearAllMocks();
    await clearDatabase(app.db);
    actor = null;
    app.close();
  });

  describe('POST /items', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));

      const payload = FolderItemFactory();
      const response = await app.inject({
        method: HttpMethod.Post,
        url: '/items',
        payload,
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Create successfully', async () => {
        const payload = FolderItemFactory();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items',
          payload,
        });

        // check response value
        const newItem = response.json();
        expectItem(newItem, payload);
        expect(response.statusCode).toBe(StatusCodes.OK);

        // check item exists in db
        const item = await testUtils.itemRepository.get(newItem.id);
        expect(item?.id).toEqual(newItem.id);

        // a membership is created for this item
        const membership = await ItemMembershipRepository.findOneBy({ item: { id: newItem.id } });
        expect(membership?.permission).toEqual(PermissionLevel.Admin);
        // check some creator properties are not leaked
        expect(newItem.creator.id).toBeTruthy();
        expect(newItem.creator.createdAt).toBeFalsy();

        // order is null for root
        expect(await testUtils.getOrderForItemId(newItem.id)).toBeNull();
      });

      it('Create successfully in parent item', async () => {
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        // child
        const child = await testUtils.saveItem({
          actor,
          parentItem: parent,
        });
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });
        const newItem = response.json();

        expectItem(newItem, payload, actor, parent);
        expect(response.statusCode).toBe(StatusCodes.OK);

        // a membership does not need to be created for item with admin rights
        const nbItemMemberships = await ItemMembershipRepository.count();
        expect(nbItemMemberships).toEqual(1);

        // add at beginning
        await testUtils.expectOrder(newItem.id, undefined, child.id);
      });

      it('Create successfully in shared parent item', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({ member });
        await testUtils.saveMembership({
          member: actor,
          item: parent,
          permission: PermissionLevel.Write,
        });
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor, parent);
        expect(response.statusCode).toBe(StatusCodes.OK);

        // a membership is created for this item
        // one membership for the owner
        // one membership for sharing
        // admin for the new item
        expect(await ItemMembershipRepository.count()).toEqual(3);
      });

      it('Create successfully with geolocation', async () => {
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload: { ...payload, geolocation: { lat: 1, lng: 2 } },
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);

        expect(await AppDataSource.getRepository(ItemGeolocation).count()).toEqual(1);
      });

      it('Create successfully with language', async () => {
        const payload = FolderItemFactory({ lang: 'fr' });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Create successfully with description placement above and should not erase default thumbnail', async () => {
        const payload = FolderItemFactory({
          settings: { descriptionPlacement: DescriptionPlacement.ABOVE },
        });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);
        expect(newItem.settings.descriptionPlacement).toBe(DescriptionPlacement.ABOVE);
        expect(newItem.settings.hasThumbnail).toBe(false);
      });

      it('Filter out bad setting when creating', async () => {
        const BAD_SETTING = { INVALID: 'Not a valid setting' };
        const VALID_SETTING = { descriptionPlacement: DescriptionPlacement.ABOVE };

        const payload = FolderItemFactory({
          settings: {
            ...BAD_SETTING,
            ...VALID_SETTING,
          },
        });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, { ...payload, settings: VALID_SETTING }, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);
        expect(newItem.settings.descriptionPlacement).toBe(VALID_SETTING.descriptionPlacement);
        expect(Object.keys(newItem.settings)).not.toContain(Object.keys(BAD_SETTING)[0]);
      });

      it('Create successfully with empty display name', async () => {
        const payload = FolderItemFactory({ displayName: '' });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload: { ...payload },
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(newItem.displayName).toEqual('');
        expect(response.statusCode).toBe(StatusCodes.OK);

        expect(await AppDataSource.getRepository(Item).count()).toEqual(1);
      });

      it('Create successfully with between children', async () => {
        const payload = FolderItemFactory();
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const previousItem = await testUtils.saveItem({ parentItem, item: { order: 1 } });
        const afterItem = await testUtils.saveItem({ parentItem, item: { order: 2 } });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          query: { parentId: parentItem.id, previousItemId: previousItem.id },
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);

        await testUtils.expectOrder(newItem.id, previousItem.id, afterItem.id);
      });

      it('Create successfully at end', async () => {
        const payload = FolderItemFactory();
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        // first item noise
        await testUtils.saveItem({ parentItem, item: { order: 1 } });
        const previousItem = await testUtils.saveItem({ parentItem, item: { order: 40 } });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          query: { parentId: parentItem.id, previousItemId: previousItem.id },
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);

        await testUtils.expectOrder(newItem.id, previousItem.id);
      });

      it('Create successfully after invalid child adds at end', async () => {
        const payload = FolderItemFactory();
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const child = await testUtils.saveItem({ parentItem, item: { order: 30 } });

        // noise, child in another parent
        const { item: otherParent } = await testUtils.saveItemAndMembership({ member: actor });
        const anotherChild = await testUtils.saveItem({
          parentItem: otherParent,
          item: { order: 100 },
        });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          query: { parentId: parentItem.id, previousItemId: anotherChild.id },
          payload,
        });

        const newItem = response.json();
        expectItem(newItem, payload, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);

        // should be after child, since another child is not valid
        await testUtils.expectOrder(newItem.id, child.id, anotherChild.id);
      });

      it('Throw if geolocation is partial', async () => {
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload: { ...payload, geolocation: { lat: 1 } },
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
        // no item nor geolocation is created
        expect(await testUtils.rawItemRepository.count()).toEqual(0);
        expect(await AppDataSource.getRepository(ItemGeolocation).count()).toEqual(0);

        const response1 = await app.inject({
          method: HttpMethod.Post,
          url: `/items`,
          payload: { ...payload, geolocation: { lng: 1 } },
        });

        expect(response1.statusCode).toBe(StatusCodes.BAD_REQUEST);
        // no item nor geolocation is created
        expect(await testUtils.rawItemRepository.count()).toEqual(0);
        expect(await AppDataSource.getRepository(ItemGeolocation).count()).toEqual(0);
      });

      it('Bad request if name is invalid', async () => {
        // by default the item creator use an invalid item type
        const newItem = FolderItemFactory({ name: '' });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items',
          payload: newItem,
        });
        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);

        // by default the item creator use an invalid item type
        const newItem1 = FolderItemFactory({ name: ' ' });
        const response1 = await app.inject({
          method: HttpMethod.Post,
          url: '/items',
          payload: newItem1,
        });
        expect(response1.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response1.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Bad request if display name is invalid', async () => {
        const newItem = FolderItemFactory({ displayName: ' ' });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items',
          payload: newItem,
        });
        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Bad request if type is invalid', async () => {
        // by default the item creator use an invalid item type
        const newItem = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items',
          payload: { ...newItem, type: 'invalid-type' },
        });
        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Bad request if parentId id is invalid', async () => {
        const payload = FolderItemFactory();
        const parentId = 'invalid-id';
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parentId}`,
          payload,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Cannot create item in non-existing parent', async () => {
        const payload = FolderItemFactory();
        const parentId = uuidv4();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parentId}`,
          payload,
        });

        expect(response.statusMessage).toEqual('Not Found');
        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      });

      it('Cannot create item if member does not have membership on parent', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({ member });
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
        expect(response.json()).toEqual(new MemberCannotAccess(parent.id));
      });

      it('Cannot create item if member can only read parent', async () => {
        const owner = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: owner,
          permission: PermissionLevel.Read,
        });

        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
        expect(response.json()).toEqual(new MemberCannotWriteItem(parent.id));
      });

      it('Cannot create item if parent item has too many children', async () => {
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const payload = FolderItemFactory();

        // save maximum children
        await testUtils.saveItems({ nb: MAX_NUMBER_OF_CHILDREN, parentItem: parent, actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
        expect(response.json()).toEqual(new TooManyChildren());
      });

      it('Cannot create item if parent is too deep in hierarchy', async () => {
        const payload = FolderItemFactory();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const currentParent = await saveUntilMaxDescendants(parent, actor);

        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${currentParent.id}`,
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
        expect(response.json()).toEqual(new HierarchyTooDeep());
      });

      it('Cannot create inside non-folder item', async () => {
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        const payload = FolderItemFactory();
        const response = await app.inject({
          method: HttpMethod.Post,
          url: `/items?parentId=${parent.id}`,
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
        expect(response.json()).toMatchObject(new ItemNotFolder({ id: parent.id }));
      });
    });
  });

  describe('POST /items/with-thumbnail', () => {
    beforeEach(async () => {
      ({ app, actor } = await build());
    });
    it('Post item with thumbnail', async () => {
      const imageStream = fs.createReadStream(path.resolve(__dirname, './fixtures/image.png'));
      const itemName = 'Test Item';
      const payload = new FormData();
      payload.append('name', itemName);
      payload.append('type', ItemType.FOLDER);
      payload.append('description', '');
      payload.append('file', imageStream);
      const response = await app.inject({
        method: HttpMethod.Post,
        url: `/items/with-thumbnail`,
        payload,
        headers: payload.getHeaders(),
      });

      const newItem = response.json();
      expectItem(
        newItem,
        FolderItemFactory({
          name: itemName,
          type: ItemType.FOLDER,
          description: '',
          settings: { hasThumbnail: true },
          lang: 'en',
        }),
        actor,
      );
      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(uploadDoneMock).toHaveBeenCalled();
    });
  });

  describe('GET /items/:id', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: `/items/${item.id}`,
      });

      expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully', async () => {
        const { packedItem } = await testUtils.saveItemAndMembership({ member: actor });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${packedItem.id}`,
        });

        const returnedItem = response.json();
        expectPackedItem(returnedItem, packedItem, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Returns successfully with permission', async () => {
        const { packedItem } = await testUtils.saveItemAndMembership({
          member: actor,
          permission: PermissionLevel.Read,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${packedItem.id}`,
        });

        const returnedItem = response.json();
        expectPackedItem(returnedItem, packedItem, actor);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Bad Request for invalid id', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/invalid-id',
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Cannot get item if have no membership', async () => {
        const member = await saveMember();
        const item = await testUtils.saveItem({ actor: member });
        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${item.id}`,
        });

        expect(response.json()).toEqual(new MemberCannotAccess(item.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
    });

    describe('Public', () => {
      it('Returns successfully', async () => {
        ({ app } = await build({ member: null }));
        const member = await saveMember();
        const { item, publicTag } = await testUtils.savePublicItem({ actor: member });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${item.id}`,
        });

        const returnedItem = response.json();
        expectPackedItem(returnedItem, { ...item, permission: null }, actor, undefined, [
          publicTag,
        ]);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
      it('Returns successfully for write right', async () => {
        ({ app, actor } = await build());
        const { item, publicTag } = await testUtils.savePublicItem({ actor });
        await testUtils.saveMembership({ item, member: actor, permission: PermissionLevel.Write });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${item.id}`,
        });

        const returnedItem = response.json();
        expectPackedItem(
          returnedItem,
          { ...item, permission: PermissionLevel.Write },
          actor,
          undefined,
          [publicTag],
        );
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
    });
  });
  // get many items
  describe('GET /items?id=<id>', () => {
    // warning: this will change if it becomes a public endpoint
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: '/items',
        query: { id: [item.id] },
      });
      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(response.json().errors[0]).toMatchObject(new MemberCannotAccess(item.id));
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully', async () => {
        const items: PackedItem[] = [];
        for (let i = 0; i < 3; i++) {
          const { packedItem } = await testUtils.saveItemAndMembership({ member: actor });
          items.push(packedItem);
        }

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items',
          query: { id: items.map(({ id }) => id) },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const { data, errors } = response.json();
        expect(errors).toHaveLength(0);
        items.forEach(({ id }) => {
          expectPackedItem(
            data[id],
            items.find(({ id: thisId }) => thisId === id),
          );
        });
      });
      it('Returns one item successfully for valid item', async () => {
        const { item } = await testUtils.saveItemAndMembership({ member: actor });
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items',
          query: { id: [item.id] },
        });

        expectPackedItem(response.json().data[item.id], {
          ...item,
          permission: PermissionLevel.Admin,
        });
        expect(response.json().errors).toHaveLength(0);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
      it('Bad request for one invalid item', async () => {
        const { item } = await testUtils.saveItemAndMembership({ member: actor });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items',
          query: { id: [item.id, 'invalid-id'] },
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Returns one error for one missing item', async () => {
        const missingId = uuidv4();
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items',
          query: { id: [...items.map(({ id }) => id), missingId] },
        });

        const { data, errors } = response.json();
        items.forEach(({ id }) => {
          expectItem(
            data[id],
            items.find(({ id: thisId }) => thisId === id),
          );
        });
        expect(data[missingId]).toBeFalsy();

        expect(errors).toContainEqual(new ItemNotFound(missingId));
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
    });

    describe('Public', () => {
      it('Returns successfully', async () => {
        ({ app } = await build({ member: null }));
        const member = await saveMember();
        const items: Item[] = [];
        const publicTags: ItemTag[] = [];
        for (let i = 0; i < 3; i++) {
          const { item, publicTag } = await testUtils.savePublicItem({ actor: member });
          items.push(item);
          publicTags.push(publicTag);
        }

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items',
          query: { id: items.map(({ id }) => id) },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const { data, errors } = response.json();
        expect(errors).toHaveLength(0);
        items.forEach(({ id }, idx) => {
          expectPackedItem(
            data[id],
            {
              ...items.find(({ id: thisId }) => thisId === id),
              permission: null,
            },
            member,
            undefined,
            [publicTags[idx]],
          );
        });
      });
    });
  });
  describe('GET /items/own', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: '/items/own',
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item3 } = await testUtils.saveItemAndMembership({ member: actor });
        const items = [item1, item2, item3];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/own',
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const data = response.json();
        expect(data).toHaveLength(items.length);
        items.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            items.find(({ id: thisId }) => thisId === id),
          );
        });
      });
    });
  });
  describe('GET /items/shared-with', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: '/items/own',
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      let items;
      let member;

      beforeEach(async () => {
        ({ app, actor } = await build());

        member = await saveMember();
        const { item: item1 } = await testUtils.saveItemAndMembership({ member });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member });
        const { item: item3 } = await testUtils.saveItemAndMembership({ member });
        items = [item1, item2, item3];
        await testUtils.saveMembership({ item: item1, member: actor });
        await testUtils.saveMembership({
          item: item2,
          member: actor,
          permission: PermissionLevel.Write,
        });
        await testUtils.saveMembership({
          item: item3,
          member: actor,
          permission: PermissionLevel.Read,
        });

        // save own item that should not be returned
        await testUtils.saveItemAndMembership({ member: actor });
      });

      it('Returns successfully', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with',
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const data = response.json();
        expect(data).toHaveLength(items.length);
        items.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            items.find(({ id: thisId }) => thisId === id),
          );
        });
      });

      it('Returns successfully with read permission filter', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with?permission=read',
        });
        const data = response.json();
        expect(data).toHaveLength(items.length);
        items.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            items.find(({ id: thisId }) => thisId === id),
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Returns successfully with write permission filter', async () => {
        const validItems = items.slice(0, 2);
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with?permission=write',
        });
        const data = response.json();
        expect(data).toHaveLength(validItems.length);

        validItems.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            validItems.find(({ id: thisId }) => thisId === id),
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Returns successfully with admin permission filter', async () => {
        const validItems = items.slice(0, 1);
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with?permission=admin',
        });
        const data = response.json();
        expect(data).toHaveLength(validItems.length);

        validItems.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            validItems.find(({ id: thisId }) => thisId === id),
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Returns successfully shared siblings', async () => {
        // create siblings
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member });
        const { item: item1 } = await testUtils.saveItemAndMembership({ member, parentItem });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member, parentItem });
        items = [item1, item2];
        await testUtils.saveMembership({
          item: item1,
          member: actor,
          permission: PermissionLevel.Read,
        });
        await testUtils.saveMembership({
          item: item2,
          member: actor,
          permission: PermissionLevel.Write,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with',
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const data = response.json();
        // should at least contain both siblings
        items.forEach(({ id }) => {
          expectItem(
            data.find(({ id: thisId }) => thisId === id),
            items.find(({ id: thisId }) => thisId === id),
          );
        });
      });

      it('Should return only parent if parent and siblings are shared', async () => {
        // create siblings
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member });
        const { item: item1 } = await testUtils.saveItemAndMembership({ member, parentItem });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member, parentItem });
        await testUtils.saveMembership({
          item: parentItem,
          member: actor,
          permission: PermissionLevel.Read,
        });
        await testUtils.saveMembership({
          item: item1,
          member: actor,
          permission: PermissionLevel.Read,
        });
        await testUtils.saveMembership({
          item: item2,
          member: actor,
          permission: PermissionLevel.Write,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/shared-with',
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const data = response.json();
        // should contain parent but not children
        expectItem(
          data.find(({ id: thisId }) => thisId === parentItem.id),
          parentItem,
        );
        expect(data.find(({ id: thisId }) => thisId === item1.id)).toBeFalsy();
        expect(data.find(({ id: thisId }) => thisId === item2.id)).toBeFalsy();
      });
    });
  });
  describe('GET /items/accessible', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: '/items/accessible',
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully owned and shared items', async () => {
        // owned items
        const { packedItem: item1, item: parentItem1 } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const { packedItem: item3 } = await testUtils.saveItemAndMembership({ member: actor });

        // shared
        const bob = await saveMember();
        const { packedItem: item4, item: parentItem4 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
        });
        const { item: parentItem5 } = await testUtils.saveItemAndMembership({ member: bob });
        const { packedItem: item6 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          parentItem: parentItem5,
        });

        // should not return these items
        await testUtils.saveItemAndMembership({ member: bob });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: parentItem1 });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: parentItem4 });

        const items = [item1, item2, item3, item4, item6];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/accessible',
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);

        expectManyPackedItems(data, items);
      });

      it('Returns successfully items for member id', async () => {
        await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor });

        const bob = await saveMember();
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
        });

        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible?creatorId=${bob.id}`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully sorted items by name asc', async () => {
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: '2' },
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: '3' },
        });
        const { packedItem: item3 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: '1' },
        });

        const items = [item3, item1, item2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible?sortBy=${SortBy.ItemName}&ordering=asc`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully sorted items by type desc', async () => {
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.FOLDER },
        });
        const { packedItem: item3 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.APP },
        });

        const items = [item2, item1, item3];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible?sortBy=${SortBy.ItemType}&ordering=desc`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully sorted items by creator name asc', async () => {
        const anna = await saveMember(MemberFactory({ name: 'anna' }));
        const bob = await saveMember(MemberFactory({ name: 'bob' }));
        const cedric = await saveMember(MemberFactory({ name: 'cedric' }));
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          item: { type: ItemType.DOCUMENT },
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          creator: anna,
          member: actor,
          item: { type: ItemType.FOLDER },
        });
        const { packedItem: item3 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: cedric,
          item: { type: ItemType.APP },
        });

        const items = [item2, item1, item3];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible?sortBy=${SortBy.ItemCreatorName}&ordering=asc`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully items for search', async () => {
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'dog' },
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'dog' },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'cat' },
        });
        // noise
        const member = await saveMember();
        await testUtils.saveItemAndMembership({
          member,
          item: { name: 'dog' },
        });

        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: { keywords: ['dogs'] },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully items by read', async () => {
        const bob = await saveMember();
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          permission: PermissionLevel.Read,
          item: { type: ItemType.DOCUMENT },
        });

        // noise
        await testUtils.saveItemAndMembership({
          member: actor,
          permission: PermissionLevel.Admin,
          item: { type: ItemType.FOLDER },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          permission: PermissionLevel.Write,
          item: { type: ItemType.APP },
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            sortBy: SortBy.ItemCreatorName,
            ordering: 'asc',
            permissions: [PermissionLevel.Read],
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(1);
        expect(data).toHaveLength(1);
        expectPackedItem(data[0], item1);
      });

      it('Returns successfully items by write and admin', async () => {
        const anna = await saveMember(MemberFactory({ name: 'anna' }));
        const bob = await saveMember(MemberFactory({ name: 'bob' }));
        await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          permission: PermissionLevel.Read,
          item: { type: ItemType.DOCUMENT },
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: anna,
          permission: PermissionLevel.Admin,
          item: { type: ItemType.FOLDER },
        });
        const { packedItem: item3 } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          permission: PermissionLevel.Write,
          item: { type: ItemType.APP },
        });
        const items = [item2, item3];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            sortBy: SortBy.ItemCreatorName,
            ordering: 'asc',
            permissions: [PermissionLevel.Write, PermissionLevel.Admin],
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(items.length);
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Returns successfully folder items', async () => {
        const bob = await saveMember();
        const { packedItem: itemFolder1 } = await testUtils.saveItemAndMembership({
          member: actor,
          permission: PermissionLevel.Admin,
          item: { type: ItemType.FOLDER },
        });
        const { packedItem: itemFolder2 } = await testUtils.saveItemAndMembership({
          member: actor,
          permission: PermissionLevel.Write,
          item: { type: ItemType.FOLDER },
        });
        const { packedItem: notAFolder } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: bob,
          permission: PermissionLevel.Write,
          item: { type: ItemType.APP },
        });

        const sortByName = (a, b) => a.name.localeCompare(b.name);

        const folders = [itemFolder1, itemFolder2].sort(sortByName);

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            types: [ItemType.FOLDER],
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        const sortedData = data.sort(sortByName);
        expect(totalCount).toEqual(folders.length);
        expect(data).toHaveLength(folders.length);
        folders.forEach((folder, idx) => {
          expectPackedItem(sortedData[idx], folder);
          expect(() => expectPackedItem(sortedData[idx], notAFolder)).toThrow(Error);
        });
      });

      it('Throws for wrong sort by', async () => {
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.FOLDER },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.APP },
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            sortBy: 'nimp',
            ordering: Ordering.DESC,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Throws for wrong ordering', async () => {
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.FOLDER },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.APP },
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            sortBy: SortBy.ItemName,
            ordering: 'nimp',
          },
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Throws for wrong item types', async () => {
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.FOLDER },
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.APP },
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/accessible`,
          query: {
            types: 'nimp',
          },
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Returns successfully paginated items', async () => {
        await testUtils.saveItemAndMembership({ member: actor, item: { name: '2' } });
        await testUtils.saveItemAndMembership({ member: actor, item: { name: '1' } });
        const { packedItem } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: '3' },
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          // add sorting for result to be less flacky
          url: `/items/accessible?ordering=asc&sortBy=${SortBy.ItemName}&pageSize=1&page=3`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const { data, totalCount } = response.json();
        expect(totalCount).toEqual(3);
        expect(data).toHaveLength(1);
        expectPackedItem(data[0], packedItem);
      });
    });
  });
  describe('GET /items/:id/children', () => {
    // warning: this will change if the endpoint becomes public
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: `/items/${item.id}/children`,
      });

      expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const { packedItem: child1, item: parentItem1 } = await testUtils.saveItemAndMembership({
          member: actor,
          parentItem,
        });
        const { packedItem: child2 } = await testUtils.saveItemAndMembership({
          member: actor,
          parentItem,
        });

        const children = [child1, child2];
        // create child of child
        await testUtils.saveItemAndMembership({ member: actor, parentItem: parentItem1 });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parentItem.id}/children`,
        });

        const data = response.json();
        expect(data).toHaveLength(children.length);
        expectManyPackedItems(data, children);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Filter out hidden children on read permission', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Read,
        });
        const { item: child1 } = await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member,
          parentItem: parent,
        });
        const { item: child2 } = await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member,
          parentItem: parent,
        });
        await rawRepository.save({ item: child1, creator: actor, type: ItemTagType.Hidden });

        const children = [child2];

        // create child of child that shouldn't be returned
        await testUtils.saveItemAndMembership({ member: actor, parentItem: child1 });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/children?ordered=true`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const data = response.json();
        expect(data).toHaveLength(children.length);
        children.forEach(({ id }) => {
          expectPackedItem(
            data.find(({ id: thisId }) => thisId === id),
            // cannot use packed item because membership is saved on member != actor
            {
              ...children.find(({ id: thisId }) => thisId === id),
              permission: PermissionLevel.Read,
            },
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
      it('Filter children by Folder', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Read,
        });
        const { packedItem: notAFolder } = await testUtils.saveItemAndMembership({
          item: { name: 'child1', type: ItemType.DOCUMENT },
          member,
          parentItem: parent,
        });
        const { item: child2 } = await testUtils.saveItemAndMembership({
          item: { name: 'child2', type: ItemType.FOLDER },
          member,
          parentItem: parent,
        });
        const children = [child2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/children?types=folder`,
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        const data = response.json();
        expect(data).toHaveLength(children.length);
        children.forEach(({ id }, idx) => {
          expectPackedItem(
            data.find(({ id: thisId }) => thisId === id),
            // cannot use packed item because member != actor
            {
              ...children.find(({ id: thisId }) => thisId === id),
              permission: PermissionLevel.Read,
            },
          );
          expect(() => expectPackedItem(data[idx], notAFolder)).toThrow(Error);
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Returns successfully children with search', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Read,
        });
        const { packedItem: item1 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'dog' },
          parentItem: parent,
        });
        const { packedItem: item2 } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'dog' },
          parentItem: parent,
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          item: { name: 'cat' },
          parentItem: parent,
        });
        // noise
        await testUtils.saveItemAndMembership({
          member,
          item: { name: 'dog' },
        });

        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/children`,
          query: { keywords: ['dogs'] },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);

        const data = response.json();
        expect(data).toHaveLength(items.length);
        expectManyPackedItems(data, items);
      });

      it('Bad Request for invalid id', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/invalid-id/children',
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Cannot get children from unexisting item', async () => {
        const id = uuidv4();
        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${id}/children`,
        });

        expect(response.json()).toEqual(new ItemNotFound(id));
        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      });
      it('Cannot get children if does not have membership on parent', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({ member });
        await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member,
          parentItem: parent,
        });
        await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member,
          parentItem: parent,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/children`,
        });

        expect(response.json()).toEqual(new MemberCannotAccess(parent.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
    });

    describe('Public', () => {
      it('Returns successfully', async () => {
        ({ app } = await build({ member: null }));
        const actor = await saveMember();
        const { item: parent, publicTag } = await testUtils.savePublicItem({ actor });
        const { item: child1 } = await testUtils.savePublicItem({
          actor,
          parentItem: parent,
        });
        const { item: child2 } = await testUtils.savePublicItem({
          actor,
          parentItem: parent,
        });

        const children = [child1, child2];
        // create child of child
        await testUtils.savePublicItem({ actor, parentItem: child1 });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/children`,
        });

        const data = response.json();
        expect(data).toHaveLength(children.length);
        children.forEach(({ id }) => {
          expectPackedItem(
            data.find(({ id: thisId }) => thisId === id),
            { ...children.find(({ id: thisId }) => thisId === id), permission: null },
            actor,
            undefined,
            // inheritance
            [publicTag],
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
    });
  });

  describe('GET /items/:id/descendants', () => {
    // warning: this will change if the endpoint becomes public
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: `/items/${item.id}/descendants`,
      });

      expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully', async () => {
        const { item: parent } = await testUtils.saveItemAndMembership({ member: actor });
        const { packedItem: child1, item: parentItem1 } = await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member: actor,
          parentItem: parent,
        });
        const { packedItem: child2 } = await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member: actor,
          parentItem: parent,
        });

        const { packedItem: childOfChild } = await testUtils.saveItemAndMembership({
          member: actor,
          parentItem: parentItem1,
        });
        const descendants = [child1, child2, childOfChild];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/descendants`,
        });

        const data = response.json();
        expect(data).toHaveLength(descendants.length);
        expectManyPackedItems(data, descendants);
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
      it('Filter out hidden items for read rights', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Read,
        });
        const { item: child1 } = await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member,
          parentItem: parent,
        });
        const { item: child2 } = await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member,
          parentItem: parent,
        });
        await rawRepository.save({ item: child1, creator: member, type: ItemTagType.Hidden });

        await testUtils.saveItemAndMembership({
          member,
          parentItem: child1,
        });
        const descendants = [child2];

        // another item with child
        const { item: parent1 } = await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({
          item: { name: 'child' },
          member: actor,
          parentItem: parent1,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/descendants`,
        });

        const result = response.json();
        // cannot use packed item because member != actor
        expectPackedItem(result[0], { ...descendants[0], permission: PermissionLevel.Read });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Bad Request for invalid id', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/invalid-id/descendants',
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Cannot get descendants from unexisting item', async () => {
        const id = uuidv4();
        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${id}/descendants`,
        });

        expect(response.json()).toEqual(new ItemNotFound(id));
        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      });
      it('Cannot get descendants if does not have membership on parent', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({ member });
        await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member,
          parentItem: parent,
        });
        await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member,
          parentItem: parent,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/descendants`,
        });

        expect(response.json()).toEqual(new MemberCannotAccess(parent.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
    });

    describe('Public', () => {
      it('Returns successfully', async () => {
        ({ app } = await build({ member: null }));
        const actor = await saveMember();
        const { item: parent, publicTag } = await testUtils.savePublicItem({ actor });
        const { item: child1 } = await testUtils.savePublicItem({
          item: { name: 'child1' },
          actor,
          parentItem: parent,
        });
        const { item: child2 } = await testUtils.savePublicItem({
          item: { name: 'child2' },
          actor,
          parentItem: parent,
        });

        const { item: childOfChild } = await testUtils.savePublicItem({
          item: { name: 'child3' },
          actor,
          parentItem: child1,
        });
        const descendants = [child1, child2, childOfChild];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/descendants`,
        });

        const data = response.json();
        expect(data).toHaveLength(descendants.length);
        descendants.forEach(({ id }) => {
          expectPackedItem(
            data.find(({ id: thisId }) => thisId === id),
            { ...descendants.find(({ id: thisId }) => thisId === id), permission: null },
            actor,
            undefined,
            // inheritance
            [publicTag],
          );
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
    });
  });

  describe('GET /items/:id/parents', () => {
    it('Throws if signed out and item is private', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Get,
        url: `/items/${item.id}/parents`,
      });

      expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Returns successfully in order', async () => {
        const { packedItem: parent, item: parentItem } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const { packedItem: child1, item: parentItem1 } = await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member: actor,
          parentItem,
        });
        // noise
        await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member: actor,
          parentItem,
        });

        const { item: childOfChild } = await testUtils.saveItemAndMembership({
          member: actor,
          parentItem: parentItem1,
        });
        const parents = [parent, child1];

        // patch item to force reorder
        await testUtils.itemRepository.patch(parent.id, { name: 'newname' });
        parent.name = 'newname';

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${childOfChild.id}/parents`,
        });

        const data = response.json();
        expect(data).toHaveLength(parents.length);
        data.forEach((p, idx) => {
          expectPackedItem(p, parents[idx]);
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
      it('Bad Request for invalid id', async () => {
        const response = await app.inject({
          method: HttpMethod.Get,
          url: '/items/invalid-id/parents',
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Cannot get parents from unexisting item', async () => {
        const id = uuidv4();
        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${id}/parents`,
        });

        expect(response.json()).toEqual(new ItemNotFound(id));
        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      });
      it('Cannot get parents if does not have membership on parent', async () => {
        const member = await saveMember();
        const { item: parent } = await testUtils.saveItemAndMembership({ member });
        await testUtils.saveItemAndMembership({
          item: { name: 'child1' },
          member,
          parentItem: parent,
        });
        await testUtils.saveItemAndMembership({
          item: { name: 'child2' },
          member,
          parentItem: parent,
        });

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${parent.id}/parents`,
        });

        expect(response.json()).toEqual(new MemberCannotAccess(parent.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
    });

    describe('Public', () => {
      it('Returns successfully', async () => {
        ({ app } = await build({ member: null }));
        const { item: parent, publicTag } = await testUtils.savePublicItem({ actor: null });
        const { item: child1 } = await testUtils.savePublicItem({
          item: { name: 'child1' },
          actor: null,
          parentItem: parent,
        });

        const { item: childOfChild } = await testUtils.savePublicItem({
          item: { name: 'child3' },
          actor: null,
          parentItem: child1,
        });

        // noise
        await testUtils.savePublicItem({
          item: { name: 'child2' },
          actor: null,
          parentItem: parent,
        });

        const parents = [parent, child1];

        const response = await app.inject({
          method: HttpMethod.Get,
          url: `/items/${childOfChild.id}/parents`,
        });

        const data = response.json();
        expect(data).toHaveLength(parents.length);
        data.forEach((p, idx) => {
          expectPackedItem(p, { ...parents[idx], permission: null }, undefined, undefined, [
            publicTag,
          ]);
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });
    });
  });

  describe('PATCH /items/:id', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Patch,
        url: `/items/${item.id}`,
        payload: { name: 'new name' },
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Update successfully', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          item: {
            type: ItemType.DOCUMENT,
            extra: {
              [ItemType.DOCUMENT]: {
                content: 'content',
              },
            },
          },
          member: actor,
        });
        const payload = {
          name: 'new name',
          extra: {
            [ItemType.DOCUMENT]: {
              content: 'new content',
            },
          },
          settings: {
            hasThumbnail: true,
          },
        };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        // this test a bit how we deal with extra: it replaces existing keys
        expectItem(response.json(), {
          ...item,
          ...payload,
          // BUG: folder extra should not contain extra
          extra: {
            document: {
              ...item.extra[item.type],
              ...payload.extra[item.type],
            },
          },
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Update successfully new language', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const payload = {
          lang: 'fr',
        };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        // this test a bit how we deal with extra: it replaces existing keys
        expectItem(response.json(), {
          ...item,
          ...payload,
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Update successfully description placement above', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const payload = {
          settings: {
            ...item.settings,
            descriptionPlacement: DescriptionPlacement.ABOVE,
          },
        };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        const newItem = response.json();

        // this test a bit how we deal with extra: it replaces existing keys
        expectItem(newItem, {
          ...item,
          ...payload,
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
        expect(newItem.settings.descriptionPlacement).toBe(DescriptionPlacement.ABOVE);
        expect(newItem.settings.hasThumbnail).toBeFalsy();
      });

      it('Update successfully link settings', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const payload = {
          settings: {
            showLinkButton: false,
            showLinkIframe: true,
          },
        };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        const newItem = response.json();

        expectItem(newItem, {
          ...item,
          ...payload,
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
        expect(newItem.settings.showLinkButton).toBe(false);
        expect(newItem.settings.showLinkIframe).toBe(true);
        expect(newItem.settings.hasThumbnail).toBeFalsy();
      });

      it('Update successfully with empty display name', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { displayName: 'Not empty' },
        });

        const payload = { displayName: '' };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        const newItem = response.json();

        expect(newItem.displayName).toEqual('');
        expect(response.statusCode).toBe(StatusCodes.OK);
      });

      it('Filter out bad setting when updating', async () => {
        const BAD_SETTING = { INVALID: 'Not a valid setting' };
        const VALID_SETTING = { descriptionPlacement: DescriptionPlacement.ABOVE };

        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const payload = {
          settings: {
            ...item.settings,
            ...VALID_SETTING,
            ...BAD_SETTING,
          },
        };

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        const newItem = response.json();

        // this test a bit how we deal with extra: it replaces existing keys
        expectItem(newItem, {
          ...item,
          ...payload,
          settings: VALID_SETTING,
        });
        expect(response.statusCode).toBe(StatusCodes.OK);
        expect(newItem.settings.descriptionPlacement).toBe(VALID_SETTING.descriptionPlacement);
        expect(Object.keys(newItem.settings)).not.toContain(Object.keys(BAD_SETTING)[0]);
      });

      it('Bad request if id is invalid', async () => {
        const payload = {
          name: 'new name',
        };
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: '/items/invalid-id',
          payload,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Bad Request if extra is invalid', async () => {
        const payload = {
          name: 'new name',
          extra: { key: 'false' },
        };
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${uuidv4()}`,
          payload,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Bad Request if display name is invalid', async () => {
        const payload = { displayName: ' ' };
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${uuidv4()}`,
          payload,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Cannot update not found item given id', async () => {
        const payload = {
          name: 'new name',
        };
        const id = uuidv4();
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${id}`,
          payload,
        });

        expect(response.json()).toEqual(new ItemNotFound(id));
        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      });
      it('Cannot update item if does not have membership', async () => {
        const payload = {
          name: 'new name',
        };
        const member = await saveMember();
        const { item } = await testUtils.saveItemAndMembership({ member });

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        expect(response.json()).toEqual(new MemberCannotAccess(item.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
      it('Cannot update item if has only read membership', async () => {
        const payload = {
          name: 'new name',
        };
        const member = await saveMember();
        const { item } = await testUtils.saveItemAndMembership({ member });
        await testUtils.saveMembership({ item, member: actor, permission: PermissionLevel.Read });
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${item.id}`,
          payload,
        });

        expect(response.json()).toEqual(new MemberCannotWriteItem(item.id));
        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      });
    });
  });
  // update many items
  describe('PATCH /items', () => {
    const payload = {
      name: 'new name',
    };
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });
      const payload = { name: 'new name' };

      const response = await app.inject({
        method: HttpMethod.Patch,
        url: '/items',
        query: { id: [item.id] },
        payload,
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Update successfully', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: '/items',
          query: { id: items.map(({ id }) => id) },
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);
        await waitForExpect(async () => {
          const { data, errors } = await testUtils.itemRepository.getMany(
            items.map(({ id }) => id),
          );
          Object.entries(data).forEach(([id, result]) => {
            const changes = { ...items.find(({ id: thisId }) => thisId === id), ...payload };
            expectItem(result, changes);
          });
          expect(Object.keys(data)).toHaveLength(items.length);
          expect(errors).toHaveLength(0);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Nothing updates if one item id is invalid', async () => {
        const missingItemId = uuidv4();
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: '/items',
          query: { id: [...items.map(({ id }) => id), missingItemId] },
          payload,
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);
        await waitForExpect(async () => {
          const { data, errors } = await testUtils.itemRepository.getMany(
            items.map(({ id }) => id),
          );
          Object.entries(data).forEach(([id, result]) => {
            expectItem(
              result,
              items.find(({ id: thisId }) => thisId === id),
            );
          });
          expect(Object.keys(data)).toHaveLength(items.length);
          expect(errors).toHaveLength(0);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Bad Request for one invalid id', async () => {
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: '/items',
          query: { id: [uuidv4(), 'invalid-id'] },
          payload,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Bad Request for invalid extra', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        const items = [item1, item2];

        const payload1 = {
          name: 'new name',
          extra: { some: 'content' },
        };
        const response = await app.inject({
          method: HttpMethod.Patch,
          url: '/items',
          query: { id: items.map(({ id }) => id) },
          payload: payload1,
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
    });
  });

  // delete many items
  describe('DELETE /items', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Delete,
        url: '/items',
        query: { id: [item.id] },
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });
      it('Delete successfully', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: item1 });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Delete,
          url: '/items',
          query: { id: items.map(({ id }) => id) },
        });

        expect(response.json()).toEqual(items.map(({ id }) => id));
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);
        await waitForExpect(async () => {
          const remaining = await testUtils.rawItemRepository.count();
          expect(remaining).toEqual(0);
          const memberships = await ItemMembershipRepository.count();
          expect(memberships).toEqual(0);
          const { errors } = await testUtils.itemRepository.getMany(items.map(({ id }) => id));
          expect(errors).toHaveLength(items.length);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Delete successfully one item', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: item1 });
        const response = await app.inject({
          method: HttpMethod.Delete,
          url: '/items',
          query: { id: [item1.id] },
        });

        expect(response.json()).toEqual([item1.id]);
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);
        await waitForExpect(async () => {
          expect(await testUtils.rawItemRepository.count()).toEqual(0);

          const memberships = await ItemMembershipRepository.count();
          expect(memberships).toEqual(0);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Delete successfully one item in parent, with children and memberships', async () => {
        // root with membership for two members
        const { item: root } = await testUtils.saveItemAndMembership({ member: actor });
        const member = await saveMember();
        await testUtils.saveMembership({ member, item: root });

        // parent to delete and its child
        const { item: parent } = await testUtils.saveItemAndMembership({
          member: actor,
          parentItem: root,
        });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: parent });

        const response = await app.inject({
          method: HttpMethod.Delete,
          url: '/items',
          query: { id: [parent.id] },
        });

        expect(response.json()).toEqual([parent.id]);
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);
        await waitForExpect(async () => {
          const remaining = await testUtils.rawItemRepository.count();
          // should keep root
          expect(remaining).toEqual(1);

          const memberships = await ItemMembershipRepository.count();
          // should keep root membership for actor and member
          expect(memberships).toEqual(2);

          // ws should not fail
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Bad request if one id is invalid', async () => {
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: item1 });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Delete,
          url: '/items',
          query: { id: [...items.map(({ id }) => id), 'invalid-id'] },
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Does not delete items if item does not exist', async () => {
        const missingId = uuidv4();
        const { item: item1 } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: item2 } = await testUtils.saveItemAndMembership({ member: actor });
        await testUtils.saveItemAndMembership({ member: actor, parentItem: item1 });
        const items = [item1, item2];

        const response = await app.inject({
          method: HttpMethod.Delete,
          url: '/items',
          query: { id: [...items.map(({ id }) => id), missingId] },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // items should still exist
        await waitForExpect(async () => {
          const remaining = await testUtils.rawItemRepository.find();
          remaining.forEach(({ id }) => {
            expect(remaining.find(({ id: thisId }) => thisId === id)).toBeTruthy();
          });
        });
      });
    });
  });

  // move many items
  describe('POST /items/move', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item: item1 } = await testUtils.saveItemAndMembership({ member });
      const { item: item2 } = await testUtils.saveItemAndMembership({ member });
      const { item: item3 } = await testUtils.saveItemAndMembership({ member });
      const items = [item1, item2, item3];
      const { item: parent } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Post,
        url: '/items/move',
        query: { id: items.map(({ id }) => id) },
        payload: {
          parentId: parent.id,
        },
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Move successfully root item to parent', async () => {
        const items = await saveNbOfItems({ nb: 3, actor });
        const { item: parent } = await testUtils.saveItemAndMembership({ member: actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: parent.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a different path
        await waitForExpect(async () => {
          for (const item of items) {
            const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
            if (!result) {
              throw new Error('item does not exist!');
            }
            expect(result.path.startsWith(parent.path)).toBeTruthy();

            // membership should have been deleted because has admin rights on parent
            const im = await ItemMembershipRepository.findOneBy({
              item: { path: buildPathFromIds(parent.id, item.id) },
            });
            expect(im).toBeNull();
          }

          // order is defined, order is not guaranteed because moving is done in parallel
          const orders = await Promise.all(
            items.map(async (i) => await testUtils.getOrderForItemId(i.id)),
          );
          orders.forEach((o) => expect(o).toBeGreaterThan(0));
          // unique values
          expect(orders.length).toEqual(new Set(orders).size);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Move successfully items to root', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor, parentItem });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: items.map(({ id }) => id) },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a differnt path
        await waitForExpect(async () => {
          for (const item of items) {
            const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
            if (!result) {
              throw new Error('item does not exist!');
            }
            expect(result.path.startsWith(parentItem.path)).toBeFalsy();

            // order is defined, order is not guaranteed because moving is done in parallel
            expect(await testUtils.getOrderForItemId(item.id)).toBeNull();
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Move successfully item to root and create new membership', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        // manually save item that doesn't need a membership because of inheritance
        const item = await testUtils.saveItem({ parentItem, actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: item.id },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a different path
        await waitForExpect(async () => {
          const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
          if (!result) {
            throw new Error('item does not exist!');
          }
          expect(result.path.startsWith(parentItem.path)).toBeFalsy();

          // membership should have been created
          const im = await ItemMembershipRepository.findOneBy({
            item: { path: buildPathFromIds(item.id) },
          });
          if (!im) {
            throw new Error('item membership does not exist!');
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Move successfully item to child and delete same membership', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const { item } = await testUtils.saveItemAndMembership({ member: actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: item.id },
          payload: { parentId: parentItem.id },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a different path
        await waitForExpect(async () => {
          const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
          if (!result) {
            throw new Error('item does not exist!');
          }
          expect(result.path.startsWith(parentItem.path)).toBeTruthy();

          // membership should have been deleted
          const im = await ItemMembershipRepository.findOneBy({
            item: { path: buildPathFromIds(item.id) },
          });
          expect(im).toBeNull();
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Move successfully items to another parent', async () => {
        const { item: originalParent } = await testUtils.saveItemAndMembership({ member: actor });
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor, parentItem: originalParent });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: parentItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a different path
        await waitForExpect(async () => {
          for (const item of items) {
            const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
            if (!result) {
              throw new Error('item does not exist!');
            }
            expect(result.path.startsWith(parentItem.path)).toBeTruthy();
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Bad request if one id is invalid', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor, parentItem });
        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: [...items.map(({ id }) => id), 'invalid-id'] },
          payload: {},
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });
      it('Fail to move items if one item does not exist', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: [...items.map(({ id }) => id), uuidv4()] },
          payload: {
            parentId: parentItem.id,
          },
        });
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // item should have a different path
        await waitForExpect(async () => {
          for (const item of items) {
            const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
            if (!result) {
              throw new Error('item does not exist!');
            }
            expect(result.path.startsWith(parentItem.path)).toBeFalsy();
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Move lots of items', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: MAX_TARGETS_FOR_MODIFY_REQUEST, actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/move',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: parentItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          for (const item of items) {
            const result = await testUtils.rawItemRepository.findOneBy({ id: item.id });
            if (!result) {
              throw new Error('item does not exist!');
            }
            expect(result.path.startsWith(parentItem.path)).toBeTruthy();
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
    });
  });

  // copy many items
  describe('POST /items/copy', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item } = await testUtils.saveItemAndMembership({ member });

      const response = await app.inject({
        method: HttpMethod.Post,
        url: '/items/copy',
        query: { id: [item.id] },
        payload: {},
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });

      it('Copy successfully from root to root', async () => {
        const settings = { hasThumbnail: false, isResizable: true, isCollapsible: true };
        const creator = await saveMember();
        const items = await saveNbOfItems({
          nb: 3,
          actor: creator,
          item: { lang: 'fr', settings },
          member: actor,
        });
        const initialCount = await testUtils.rawItemRepository.count();
        const initialCountMembership = await ItemMembershipRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: items.map(({ id }) => id) },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount + items.length);
          for (const { name } of items) {
            const itemsInDb1 = await testUtils.rawItemRepository.find({
              where: { name },
              relations: { creator: true },
            });
            const itemsInDb2 = await testUtils.rawItemRepository.find({
              where: { name: `${name} (2)` },
              relations: { creator: true },
            });

            expect(itemsInDb1).toHaveLength(1);
            expect(itemsInDb2).toHaveLength(1);

            const itemsInDb = [...itemsInDb1, ...itemsInDb2];
            expect(itemsInDb).toHaveLength(2);

            // expect copied data
            expect(itemsInDb[0].type).toEqual(itemsInDb[1].type);
            expect(itemsInDb[0].description).toEqual(itemsInDb[1].description);
            expect(itemsInDb[0].settings).toEqual(settings);
            expect(itemsInDb[1].settings).toEqual(settings);
            expect(itemsInDb[0].lang).toEqual(itemsInDb[1].lang);
            // creator is different
            expect(itemsInDb[0].creator).not.toEqual(itemsInDb[1].creator);
            expect([creator.id, actor.id]).toContain(itemsInDb[0].creator!.id);
            expect([creator.id, actor.id]).toContain(itemsInDb[1].creator!.id);
            // id and path are different
            expect(itemsInDb[0].id).not.toEqual(itemsInDb[1].id);
            expect(itemsInDb[0].path).not.toEqual(itemsInDb[1].path);

            expect(await testUtils.getOrderForItemId(itemsInDb2[0].id)).toBeNull();
          }

          // check it created a new membership per item
          const newCountMembership = await ItemMembershipRepository.count();
          expect(newCountMembership).toEqual(initialCountMembership + items.length);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Copy successfully from root to item with admin rights', async () => {
        const { item: targetItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor });
        const initialCountMembership = await ItemMembershipRepository.count();
        const initialCount = await testUtils.rawItemRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: targetItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount + items.length);
          const orders: (number | null)[] = [];
          for (const { name } of items) {
            const itemsInDb = await testUtils.rawItemRepository.findBy({ name });
            expect(itemsInDb).toHaveLength(1);

            const itemsInDbCopied = await testUtils.rawItemRepository.findBy({
              name: `${name} (2)`,
            });
            expect(itemsInDbCopied).toHaveLength(1);
            orders.push(await testUtils.getOrderForItemId(itemsInDbCopied[0].id));
          }

          // check it did not create a new membership because user is admin of parent
          const newCountMembership = await ItemMembershipRepository.count();
          expect(newCountMembership).toEqual(initialCountMembership);

          // order is defined, order is not guaranteed because moving is done in parallel
          orders.forEach((o) => expect(o).toBeGreaterThan(0));
          // unique values
          expect(orders.length).toEqual(new Set(orders).size);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Copy successfully from root to item with write rights', async () => {
        const member = await saveMember();
        const { item: targetItem } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Write,
        });
        const items = await saveNbOfItems({ nb: 3, actor: member, member: actor });
        const initialCountMembership = await ItemMembershipRepository.count();
        const initialCount = await testUtils.rawItemRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: targetItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount + items.length);
          for (const { name } of items) {
            const itemsInDb = await testUtils.rawItemRepository.findBy({ name });
            expect(itemsInDb).toHaveLength(1);

            const itemsInDb2 = await testUtils.rawItemRepository.findBy({ name: `${name} (2)` });
            expect(itemsInDb2).toHaveLength(1);
          }

          // check it created a new membership because user is writer of parent
          const newCountMembership = await ItemMembershipRepository.count();
          expect(newCountMembership).toEqual(initialCountMembership + items.length);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Copy successfully root item from shared items to home', async () => {
        const member = await saveMember();
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Admin,
        });
        const { item: youngParent } = await testUtils.saveItemAndMembership({
          item: { name: 'young parent' },
          member: actor,
          creator: member,
          permission: PermissionLevel.Admin,
          parentItem: item,
        });
        // children, saved in weird order (children updated first so it appears first when fetching)
        await testUtils.saveItemAndMembership({
          item: { name: 'old child' },
          member: actor,
          creator: member,
          permission: PermissionLevel.Admin,
          parentItem: youngParent,
        });
        await testUtils.saveItemAndMembership({
          member: actor,
          creator: member,
          permission: PermissionLevel.Admin,
          parentItem: item,
        });

        await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${youngParent.id}`,
          payload: {
            name: 'new name',
          },
        });

        const initialCountMembership = await ItemMembershipRepository.count();
        const initialCount = await testUtils.rawItemRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: item.id },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount * 2);

          // check it created a new membership because user is writer of parent
          const newCountMembership = await ItemMembershipRepository.count();
          expect(newCountMembership).toEqual(initialCountMembership + 1);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Copy successfully from item to root', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const items = await saveNbOfItems({ nb: 3, actor, parentItem });
        const initialCount = await testUtils.rawItemRepository.count();
        const initialCountMembership = await ItemMembershipRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: items.map(({ id }) => id) },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount + items.length);
          for (const { name } of items) {
            const itemsInDb1 = await testUtils.rawItemRepository.findBy({ name });
            expect(itemsInDb1).toHaveLength(1);
            const itemsInDb2 = await testUtils.rawItemRepository.findBy({ name: `${name} (2)` });
            expect(itemsInDb2).toHaveLength(1);

            expect(await testUtils.getOrderForItemId(itemsInDb2[0].id)).toBeNull();
          }

          // check it did not create a new membership because user is admin of parent
          const newCountMembership = await ItemMembershipRepository.count();
          expect(newCountMembership).toEqual(initialCountMembership + items.length);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Bad request if one id is invalid', async () => {
        const items = await saveNbOfItems({ nb: 3, actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: [...items.map(({ id }) => id), 'invalid-id'] },
          payload: {},
        });

        expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      });

      it('Fail to copy if one item does not exist', async () => {
        const items = await saveNbOfItems({ nb: 3, actor });
        const missingId = uuidv4();
        const initialCount = await testUtils.rawItemRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: [...items.map(({ id }) => id), missingId] },
          payload: {},
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(initialCount);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Fail to copy if parent item is not a folder', async () => {
        const { item } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });
        const { item: parentItem } = await testUtils.saveItemAndMembership({
          member: actor,
          item: { type: ItemType.DOCUMENT },
        });

        const count = await testUtils.rawItemRepository.count();

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: [item.id] },
          payload: {
            parentId: parentItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          // contains twice the items (and the target item)
          const newCount = await testUtils.rawItemRepository.count();
          expect(newCount).toEqual(count);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
      it('Copy lots of items', async () => {
        const items = await saveNbOfItems({ nb: MAX_TARGETS_FOR_MODIFY_REQUEST, actor });
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: items.map(({ id }) => id) },
          payload: {
            parentId: parentItem.id,
          },
        });
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          for (const item of items) {
            const results = await testUtils.rawItemRepository.findBy({ name: item.name });
            const copy = await testUtils.rawItemRepository.findBy({ name: `${item.name} (2)` });
            if (!results.length && !copy.length) {
              throw new Error('item does not exist!');
            }
            expect(results).toHaveLength(1);
            expect(copy).toHaveLength(1);
            expect(copy[0].path.startsWith(parentItem.path)).toBeTruthy();
          }
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });

      it('Copy attached geolocation', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const itemGeolocationRepository = AppDataSource.getRepository(ItemGeolocation);
        const { item } = await testUtils.saveItemAndMembership({ member: actor });
        await itemGeolocationRepository.save({ item, lat: 1, lng: 22 });

        const response = await app.inject({
          method: HttpMethod.Post,
          url: '/items/copy',
          query: { id: [item.id] },
          payload: {
            parentId: parentItem.id,
          },
        });
        expect(response.statusCode).toBe(StatusCodes.ACCEPTED);

        // wait a bit for tasks to complete
        await waitForExpect(async () => {
          const results = await itemGeolocationRepository.count();
          expect(results).toEqual(2);
        }, MULTIPLE_ITEMS_LOADING_TIME);
      });
    });
  });

  // copy many items
  describe('PATCH /items/id/reorder', () => {
    it('Throws if signed out', async () => {
      ({ app } = await build({ member: null }));
      const member = await saveMember();
      const { item: parentItem } = await testUtils.saveItemAndMembership({ member });
      const toReorder = await testUtils.saveItem({
        actor: member,
        parentItem,
      });
      const previousItem = await testUtils.saveItem({
        actor: member,
        parentItem,
      });

      const response = await app.inject({
        method: HttpMethod.Patch,
        url: `/items/${toReorder.id}/reorder`,
        payload: {
          previousItemId: previousItem.id,
        },
      });

      expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED);
    });

    describe('Signed In', () => {
      beforeEach(async () => {
        ({ app, actor } = await build());
      });
      it('reorder at beginning', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const toReorder = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 10 },
        });
        const previousItem = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 5 },
        });

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${toReorder.id}/reorder`,
          payload: {
            previousItemId: previousItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        await testUtils.expectOrder(toReorder.id, previousItem.id);
      });

      it('reorder at end', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const toReorder = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 10 },
        });
        // first item
        await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 5 },
        });
        const previousItem = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 15 },
        });

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${toReorder.id}/reorder`,
          payload: {
            previousItemId: previousItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        await testUtils.expectOrder(toReorder.id, previousItem.id);
      });

      it('reorder in between', async () => {
        const { item: parentItem } = await testUtils.saveItemAndMembership({ member: actor });
        const toReorder = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 20 },
        });
        const previousItem = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 5 },
        });
        const afterItem = await testUtils.saveItem({
          actor,
          parentItem,
          item: { order: 15 },
        });

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${toReorder.id}/reorder`,
          payload: {
            previousItemId: previousItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.OK);
        await testUtils.expectOrder(toReorder.id, previousItem.id, afterItem.id);
      });

      it('reorder in root throws', async () => {
        const { item: toReorder } = await testUtils.saveItemAndMembership({
          member: actor,
        });
        const { item: previousItem } = await testUtils.saveItemAndMembership({
          member: actor,
        });

        const response = await app.inject({
          method: HttpMethod.Patch,
          url: `/items/${toReorder.id}/reorder`,
          payload: {
            previousItemId: previousItem.id,
          },
        });

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
        expect(await testUtils.getOrderForItemId(toReorder.id)).toBeNull();
      });
    });
  });
});
