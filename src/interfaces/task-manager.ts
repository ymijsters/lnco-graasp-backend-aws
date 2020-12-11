import { FastifyLoggerInstance } from 'fastify';
import { Actor } from './actor';
import { Task } from './task';

export interface TaskManager<A extends Actor, R> {
  /**
   * Run given tasks
   * @param tasks Tasks to run
   * @param log Logger instance to use during execution
   */
  run(tasks: Task<A, R>[], log?: FastifyLoggerInstance): Promise<void | R | R[]>;

  createCreateTask(actor: A, object: Partial<R>, extra?: unknown): Task<A, R>;
  createGetTask(actor: A, objectId: string): Task<A, R>;
  createUpdateTask(actor: A, objectId: string, object: Partial<R>): Task<A, R>;
  createDeleteTask(actor: A, objectId: string): Task<A, R>;
}
