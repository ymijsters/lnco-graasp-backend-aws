// global
import {
  HierarchyTooDeep, InvalidMoveTarget, ItemNotFound,
  TooManyDescendants, UserCannotAdminItem, UserCannotWriteItem
} from '../../../util/graasp-error';
import { DatabaseTransactionHandler } from '../../../plugins/database';
import { MAX_DESCENDANTS_FOR_MOVE, MAX_TREE_LEVELS } from '../../../util/config';
// other services
import { ItemMembershipService } from '../../../services/item-memberships/db-service';
import { Member } from '../../../services/members/interfaces/member';
// local
import { ItemService } from '../db-service';
import { BaseItemTask } from './base-item-task';
import { BaseItem } from '../base-item';
import { Item } from '../interfaces/item';

export class MoveItemTask extends BaseItemTask {
  get name(): string { return MoveItemTask.name; }

  constructor(member: Member, itemId: string,
    itemService: ItemService, itemMembershipService: ItemMembershipService,
    parentItemId?: string) {
    super(member, itemService, itemMembershipService);
    this.targetId = itemId;
    this.parentItemId = parentItemId;
  }

  async run(handler: DatabaseTransactionHandler): Promise<void> {
    this.status = 'RUNNING';

    // get item
    const item = await this.itemService.get(this.targetId, handler);
    if (!item) throw new ItemNotFound(this.targetId);

    // verify membership rights over item
    const hasRights = await this.itemMembershipService.canAdmin(this.actor, item, handler);
    if (!hasRights) throw new UserCannotAdminItem(this.targetId);

    // check how "big the tree is" below the item
    const numberOfDescendants = await this.itemService.getNumberOfDescendants(item, handler);
    if (numberOfDescendants > MAX_DESCENDANTS_FOR_MOVE) {
      throw new TooManyDescendants(this.targetId);
    }

    let parentItem;

    if (this.parentItemId) { // attaching tree to new parent item
      // get new parent item
      parentItem = await this.itemService.get(this.parentItemId, handler);
      if (!parentItem) throw new ItemNotFound(this.parentItemId);

      const { path: parentItemPath } = parentItem;

      // fail if
      if (
        parentItemPath.startsWith(item.path) || // moving into itself or "below" itself
        BaseItem.parentPath(item) === parentItemPath // moving to the same parent ("not moving")
      ) {
        throw new InvalidMoveTarget(this.parentItemId);
      }

      // verify membership rights over new parent item
      const hasRightsOverParentItem = await this.itemMembershipService.canWrite(this.actor, parentItem, handler);
      if (!hasRightsOverParentItem) throw new UserCannotWriteItem(this.parentItemId);

      // check how deep (number of levels) the resulting tree will be
      const levelsToFarthestChild =
        await this.itemService.getNumberOfLevelsToFarthestChild(item, handler);

      if (BaseItem.itemDepth(parentItem) + 1 + levelsToFarthestChild > MAX_TREE_LEVELS) {
        throw new HierarchyTooDeep();
      }

      // TODO: should this info go into 'message'? (it's the only exception to the rule)
      this._message = `new parent ${this.parentItemId}`;
    } else if (!BaseItem.parentPath(item)) { // moving from "no-parent" to "no-parent" ("not moving")
      throw new InvalidMoveTarget();
    }

    // move item
    await this.moveItem(item, handler, parentItem);

    this.status = 'OK';
  }

  /**
   * Does the work of moving the item and the necessary changes to all the item memberships
   * involved.
   *
   * `this.itemMembershipService.moveHousekeeping()` runs first because membership paths
   * are *automatically* updated (`ON UPDATE CASCADE`) with `this.itemService.move()` and the
   * "adjustments" need to be calculated before - considering the origin membership paths.
   *
   * * `inserts`' `itemPath`s already have the expected paths for the destination;
   * * `deletes`' `itemPath`s have the path changes after `this.itemService.move()`.
   */
  private async moveItem(item: Item, handler: DatabaseTransactionHandler, parentItem?: Item) {
    // identify all the necessary adjustments to memberships
    // TODO: maybe this whole 'magic' should happen in a db procedure?
    const { inserts, deletes } =
      await this.itemMembershipService.moveHousekeeping(item, this.actor, handler, parentItem);

    // move item (and subtree) - update paths of all items
    await this.itemService.move(item, handler, parentItem);

    // adjust memberships to keep the constraints
    if (inserts.length) await this.itemMembershipService.createMany(inserts, handler);
    if (deletes.length) await this.itemMembershipService.deleteManyMatching(deletes, handler);
  }
}
