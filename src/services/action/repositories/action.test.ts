import { addDays, formatISO } from 'date-fns';

import { FastifyInstance } from 'fastify';

import {
  ActionFactory,
  ActionTriggers,
  AggregateBy,
  AggregateFunction,
  AggregateMetric,
  Context,
  CountGroupBy,
  DiscriminatedItem,
} from '@graasp/sdk';

import build, { clearDatabase } from '../../../../test/app';
import { AppDataSource } from '../../../plugins/datasource';
import { ItemTestUtils } from '../../item/test/fixtures/items';
import { getPreviousMonthFromNow } from '../../member/plugins/action/service';
import { saveMember } from '../../member/test/fixtures/members';
import { DEFAULT_ACTIONS_SAMPLE_SIZE } from '../constants/constants';
import { Action } from '../entities/action';
import { expectActions, saveActions } from '../test/fixtures/actions';
import { ActionRepository } from './action';

const rawRepository = AppDataSource.getRepository(Action);
const testUtils = new ItemTestUtils();
const createdAt = formatISO(addDays(new Date(), -1));

describe('Action Repository', () => {
  let app: FastifyInstance;
  let actor;
  let member;
  let item;

  beforeEach(async () => {
    ({ app, actor } = await build());
    member = await saveMember();

    item = await testUtils.saveItem({ actor });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearDatabase(app.db);
    actor = null;
    member = null;
    item = null;
    app.close();
  });

  describe('postMany', () => {
    it('save many actions', async () => {
      const actions = [
        ActionFactory(),
        ActionFactory(),
        ActionFactory(),
        ActionFactory(),
      ] as unknown as Action[];

      const r = new ActionRepository();

      await r.postMany(actions);

      expect(await rawRepository.count()).toEqual(actions.length);
    });
  });

  describe('deleteAllForMember', () => {
    it('delete all actions for member', async () => {
      const bob = await saveMember();
      await saveActions(rawRepository, [
        { member },
        { member },
        { member },
        { member },
        // noise
        { member: bob },
      ]);

      const r = new ActionRepository();

      await r.deleteAllForMember(member.id);

      expect(await rawRepository.count()).toEqual(1);
    });
  });

  describe('getForMember', () => {
    it('get actions that require permissions for member within the last month', async () => {
      const item = await testUtils.saveItem({ actor: member });

      await saveActions(rawRepository, [
        {
          member,
          createdAt: new Date().toISOString(),
          type: ActionTriggers.Update,
          item: item as unknown as DiscriminatedItem,
        },
        { member, createdAt: new Date().toISOString(), type: ActionTriggers.CollectionView },
        { member, createdAt: new Date('1999-07-08').toISOString(), type: ActionTriggers.Update },
        { member, createdAt: new Date().toISOString(), type: ActionTriggers.ItemLike },
      ]);

      const r = new ActionRepository();

      const result = await r.getMemberActions(member.id, {
        startDate: getPreviousMonthFromNow(),
        endDate: new Date(),
      });

      expect(result.length).toEqual(3);
    });
  });

  describe('getForItem', () => {
    it('get all actions for item', async () => {
      const actions = await saveActions(rawRepository, [
        { item, member, createdAt },
        { item, member, createdAt },
      ]);

      // noise
      await saveActions(rawRepository, [{ member }, { member }]);

      const r = new ActionRepository();

      const result = await r.getForItem(item.path);

      expectActions(result, actions);
    });

    it('get all actions for item for max sampleSize', async () => {
      const sampleSize = 3;
      const actions = await saveActions(
        rawRepository,
        Array.from({ length: sampleSize }, () => ({ item, member, createdAt })),
      );

      // noise
      await saveActions(rawRepository, [
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { member },
        { member },
      ]);

      const r = new ActionRepository();
      const result = await r.getForItem(item.path, { sampleSize });

      expectActions(result, actions.slice(0, sampleSize));
    });

    it('get all actions for item for default sampleSize', async () => {
      const actions = await saveActions(
        rawRepository,
        Array.from({ length: DEFAULT_ACTIONS_SAMPLE_SIZE }, () => ({ item, member, createdAt })),
      );

      // noise
      await saveActions(rawRepository, [
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { item, member, createdAt: new Date('2000-12-17T03:24:00').toISOString() },
        { member },
        { member },
      ]);

      const r = new ActionRepository();
      const result = await r.getForItem(item.path);

      expect(result).toHaveLength(DEFAULT_ACTIONS_SAMPLE_SIZE);
      expectActions(result, actions);
    });

    it('get all actions for item for view', async () => {
      const sampleSize = 5;
      const view = Context.Builder;
      const actions = await saveActions(
        rawRepository,
        Array.from({ length: sampleSize }, () => ({ item, member, view, createdAt })),
      );

      // noise
      await saveActions(rawRepository, [
        {
          item,
          member,
          view: Context.Player,
          createdAt: new Date('2000-12-17T03:24:00').toISOString(),
        },
        {
          item,
          member,
          view: Context.Player,
          createdAt: new Date('2000-12-17T03:24:00').toISOString(),
        },
        {
          item,
          member,
          view: Context.Player,
          createdAt: new Date('2000-12-17T03:24:00').toISOString(),
        },
        { view: Context.Player, member },
        { view: Context.Player, member },
      ]);

      const r = new ActionRepository();
      const result = await r.getForItem(item.path, { view });

      expectActions(result, actions);
    });

    it('get all actions for item for member Id', async () => {
      const bob = await saveMember();
      const sampleSize = 5;
      const actions = await saveActions(
        rawRepository,
        Array.from({ length: sampleSize }, () => ({ item, member, createdAt })),
      );

      // noise
      await saveActions(rawRepository, [{ member: bob }, { member: bob }]);

      const r = new ActionRepository();
      const result = await r.getForItem(item.path, { memberId: member.id });

      expectActions(result, actions);
    });

    it('get all actions for item and its descendants', async () => {
      const child = await testUtils.saveItem({ actor: member, parentItem: item });

      const actions = await saveActions(rawRepository, [
        { item, member, createdAt },
        { item, member, createdAt },
        { item: child, member, createdAt },
        { item: child, member, createdAt },
        { item: child, member, createdAt },
      ]);

      // noise
      await saveActions(rawRepository, [{ member }, { member }]);

      const r = new ActionRepository();
      const result = await r.getForItem(item.path, { memberId: member.id });

      expectActions(result, actions);
    });
  });

  describe('getAggregationForItem', () => {
    it('returns nothing for no parameter', async () => {
      await saveActions(rawRepository, [
        { item, member, createdAt },
        { item, member, createdAt },
        { item, member, createdAt },
        { item, member, createdAt },
      ]);

      const r = new ActionRepository();

      const result = await r.getAggregationForItem(item.path);
      expect(result).toEqual([{ actionCount: '0' }]);
    });
    it('returns count for view only', async () => {
      const view = Context.Library;
      const actions = await saveActions(rawRepository, [
        { item, member, view, createdAt },
        { item, member, view, createdAt },
      ]);

      // noise
      await saveActions(rawRepository, [
        { item, member, view: Context.Builder },
        { item, member, view: Context.Builder },
      ]);

      const r = new ActionRepository();

      const result = await r.getAggregationForItem(item.path, { view });
      expect(result).toEqual([{ actionCount: actions.length.toString() }]);
    });

    it('returns nothing for type only', async () => {
      const type = 'type';
      await saveActions(rawRepository, [
        { item, member, type, createdAt },
        { item, member, type, createdAt },
      ]);

      // noise
      await saveActions(rawRepository, [
        { item, member, type: 'type1' },
        { item, member, type: 'type1' },
      ]);

      const r = new ActionRepository();

      const result = await r.getAggregationForItem(item.path, { types: [type] });
      expect(result).toEqual([{ actionCount: '0' }]);
    });

    it('returns count for type and view', async () => {
      const view = Context.Library;
      const type = 'type';
      const actions = await saveActions(rawRepository, [
        { item, member, type, view, createdAt },
        { item, member, type, view, createdAt },
      ]);

      // noise
      await saveActions(rawRepository, [
        { item, member, type: 'type1', view: Context.Builder },
        { item, member, type: 'type1', view: Context.Builder },
      ]);

      const r = new ActionRepository();

      const result = await r.getAggregationForItem(item.path, { view, types: [type] });
      expect(result).toEqual([{ actionCount: actions.length.toString() }]);
    });

    it('returns action count does not take into account sample size', async () => {
      const view = Context.Library;
      const sampleSize = 5;
      await saveActions(
        rawRepository,
        Array.from({ length: sampleSize }, () => ({ item, member, view, createdAt })),
      );

      // noise
      await saveActions(rawRepository, [
        { item, member, view, createdAt },
        { item, member, view, createdAt },
      ]);

      const r = new ActionRepository();

      const result = await r.getAggregationForItem(item.path, { view, sampleSize });
      expect(result).toEqual([{ actionCount: '7' }]);
    });

    describe('countGroupBy', () => {
      it('returns action count with countGroupBy ActionType and User', async () => {
        const view = Context.Library;
        const type = 'type';
        const sampleSize = 5;
        const bob = await saveMember();
        const countGroupBy = [CountGroupBy.ActionType, CountGroupBy.User];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({ item, member, view, type, createdAt })),
          { item, member: bob, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type2', createdAt },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view, sampleSize }, countGroupBy);
        expect(result).toEqual([
          { actionCount: sampleSize.toString(), actionType: type, user: member.id },
          { actionCount: '1', actionType: 'type1', user: bob.id },
          { actionCount: '1', actionType: 'type2', user: bob.id },
        ]);
      });

      it('returns action count with countGroupBy ActionLocation', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.ActionLocation];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            view,
            member,
            geolocation: { country: 'switzerland' },
            createdAt,
          })),
          {
            item,
            view,
            member,
            geolocation: { country: 'france' },
            createdAt,
          },
          {
            item,
            view,
            member,
            geolocation: { country: 'france' },
            createdAt,
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view }, countGroupBy);

        expect(result).toMatchObject([
          { actionCount: '2', actionLocation: JSON.stringify({ country: 'france' }) },
          {
            actionCount: sampleSize.toString(),
            actionLocation: JSON.stringify({ country: 'switzerland' }),
          },
        ]);
      });

      it('returns action count with countGroupBy CreatedDay', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.CreatedDay];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            view,
            member,
            createdAt: '2000-12-17T03:24:00',
          })),
          {
            item,
            view,
            member,
            createdAt: '2000-12-18T03:24:00',
          },
          {
            item,
            view,
            member,
            createdAt: '2000-12-19T03:24:00',
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          { view, startDate: '2000-12-16T03:24:00', endDate: '2000-12-20T03:24:00' },
          countGroupBy,
        );
        expect(result).toMatchObject([
          {
            actionCount: sampleSize.toString(),
            createdDay: new Date('2000-12-17T00:00:00'),
          },
          { actionCount: '1', createdDay: new Date('2000-12-18T00:00:00') },
          { actionCount: '1', createdDay: new Date('2000-12-19T00:00:00') },
        ]);
      });

      it('returns action count with countGroupBy CreatedDayOfWeek', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.CreatedDayOfWeek];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            view,
            member,
            createdAt: '2000-12-17T03:24:00',
          })),
          {
            item,
            view,
            member,
            createdAt: '2000-12-18T03:24:00',
          },
          {
            item,
            view,
            member,
            createdAt: '2000-12-19T03:24:00',
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          { view, startDate: '2000-12-16T03:24:00', endDate: '2000-12-20T03:24:00' },
          countGroupBy,
        );
        expect(result).toMatchObject([
          {
            actionCount: sampleSize.toString(),
            createdDayOfWeek: '0',
          },
          { actionCount: '1', createdDayOfWeek: '1' },
          { actionCount: '1', createdDayOfWeek: '2' },
        ]);
      });

      it('returns action count with countGroupBy CreatedTimeOfDay', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.CreatedTimeOfDay];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            view,
            member,
            createdAt: '2000-12-17T03:24:00',
          })),
          {
            item,
            view,
            member,
            createdAt: '2000-12-18T13:24:00',
          },
          {
            item,
            view,
            member,
            createdAt: '2000-12-19T23:24:00',
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          { view, startDate: '2000-12-16T03:24:00', endDate: '2000-12-20T03:24:00' },
          countGroupBy,
        );
        expect(result).toMatchObject([
          {
            actionCount: sampleSize.toString(),
            createdTimeOfDay: '3',
          },
          { actionCount: '1', createdTimeOfDay: '13' },
          { actionCount: '1', createdTimeOfDay: '23' },
        ]);
      });

      it('returns action count with countGroupBy ItemId', async () => {
        const child1 = await testUtils.saveItem({ actor: member, parentItem: item });
        const child2 = await testUtils.saveItem({ actor: member, parentItem: item });
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.ItemId];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            view,
            member,
            createdAt,
          })),
          {
            item: child1 as unknown as DiscriminatedItem,
            view,
            member,
            createdAt,
          },
          {
            item: child2 as unknown as DiscriminatedItem,
            view,
            member,
            createdAt,
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view }, countGroupBy);
        expect(result).toContainEqual({
          actionCount: sampleSize.toString(),
          itemId: item.id,
        });
        expect(result).toContainEqual({ actionCount: '1', itemId: child1.id });
        expect(result).toContainEqual({ actionCount: '1', itemId: child2.id });
      });

      it('returns action count with countGroupBy User', async () => {
        const view = Context.Library;
        const type = 'type';
        const sampleSize = 5;
        const bob = await saveMember();
        const countGroupBy = [CountGroupBy.User];
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({ item, member, view, type, createdAt })),
          { item, member: bob, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type2', createdAt },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view, sampleSize }, countGroupBy);
        expect(result).toContainEqual({ actionCount: sampleSize.toString(), user: member.id });
        expect(result).toContainEqual({ actionCount: '2', user: bob.id });
      });
    });
    describe('aggregateFunction & aggregateMetric', () => {
      it('returns aggregate result with aggregateFunction for action type', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.ActionType];
        const aggregateFunction = AggregateFunction.Count;
        const aggregateMetric = AggregateMetric.ActionType;
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            member,
            view,
            type: 'type',
            createdAt,
          })),
          { item, member, view, type: 'type1', createdAt },
          { item, member, view, type: 'type2', createdAt },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          {
            view,
          },
          countGroupBy,
          {
            aggregateFunction,
            aggregateMetric,
          },
        );
        expect(result).toContainEqual({ aggregateResult: '3' });
      });

      it('returns aggregate result with aggregateFunction for action created day', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const countGroupBy = [CountGroupBy.CreatedDay];
        const aggregateFunction = AggregateFunction.Count;
        const aggregateMetric = AggregateMetric.CreatedDay;
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            member,
            view,
            type: 'type',
            createdAt,
          })),
          { item, member, view, type: 'type1', createdAt: formatISO(addDays(new Date(), -2)) },
          { item, member, view, type: 'type2', createdAt: formatISO(addDays(new Date(), -3)) },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view }, countGroupBy, {
          aggregateFunction,
          aggregateMetric,
        });
        expect(result).toContainEqual({ aggregateResult: '3' });
      });
      it('returns average number of actions per user', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const bob = await saveMember();
        const countGroupBy = [CountGroupBy.User];
        const aggregateFunction = AggregateFunction.Avg;
        const aggregateMetric = AggregateMetric.ActionCount;
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            member,
            view,
            type: 'type',
            createdAt,
          })),
          { item, member: bob, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type2', createdAt },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(item.path, { view }, countGroupBy, {
          aggregateFunction,
          aggregateMetric,
        });
        expect(result).toHaveLength(1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(parseFloat((result[0] as any).aggregateResult)).toEqual(3.5);
      });
    });
    describe('aggregateBy', () => {
      it('returns total actions per action type', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const bob = await saveMember();
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            member,
            view,
            type: 'type',
            createdAt,
          })),
          { item, member, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type1', createdAt },
          { item, member: bob, view, type: 'type2', createdAt },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          { view },
          [CountGroupBy.User, CountGroupBy.ActionType],
          {
            aggregateFunction: AggregateFunction.Sum,
            aggregateMetric: AggregateMetric.ActionCount,
            aggregateBy: [AggregateBy.ActionType],
          },
        );

        expect(result).toContainEqual({ actionType: 'type', aggregateResult: '5' });
        expect(result).toContainEqual({ actionType: 'type1', aggregateResult: '3' });
        expect(result).toContainEqual({ actionType: 'type2', aggregateResult: '1' });
      });
      it('returns total actions per action type', async () => {
        const view = Context.Library;
        const sampleSize = 5;
        const bob = await saveMember();
        await saveActions(rawRepository, [
          ...Array.from({ length: sampleSize }, () => ({
            item,
            member,
            view,
            type: 'type',
            createdAt: '2000-12-19T03:24:00',
          })),
          { item, member, view, type: 'type1', createdAt: '2000-12-18T03:24:00' },
          {
            item,
            member: bob,
            view,
            type: 'type1',
            createdAt: '2000-12-17T03:24:00',
          },
          {
            item,
            member: bob,
            view,
            type: 'type1',
            createdAt: '2000-12-16T03:24:00',
          },
          {
            item,
            member: bob,
            view,
            type: 'type2',
            createdAt: '2000-12-15T03:24:00',
          },
        ]);

        const r = new ActionRepository();

        const result = await r.getAggregationForItem(
          item.path,
          { view, startDate: '2000-12-14T03:24:00', endDate: '2000-12-20T03:24:00' },
          [CountGroupBy.User, CountGroupBy.CreatedDay],
          {
            aggregateFunction: AggregateFunction.Avg,
            aggregateMetric: AggregateMetric.ActionCount,
            aggregateBy: [AggregateBy.CreatedDay],
          },
        );

        expect(result).toHaveLength(5);
        expect(result).toContainEqual({
          aggregateResult: '1.00000000000000000000',
          createdDay: new Date('2000-12-15T00:00:00.000Z'),
        });
        expect(result).toContainEqual({
          aggregateResult: '1.00000000000000000000',
          createdDay: new Date('2000-12-16T00:00:00.000Z'),
        });
        expect(result).toContainEqual({
          aggregateResult: '1.00000000000000000000',
          createdDay: new Date('2000-12-17T00:00:00.000Z'),
        });
        expect(result).toContainEqual({
          aggregateResult: '1.00000000000000000000',
          createdDay: new Date('2000-12-18T00:00:00.000Z'),
        });
        expect(result).toContainEqual({
          aggregateResult: '5.0000000000000000',
          createdDay: new Date('2000-12-19T00:00:00.000Z'),
        });
      });
    });
  });
});
