import { StatusCodes } from 'http-status-codes';

import { FastifyPluginAsync } from 'fastify';

import { ActionTriggers, Context, RecaptchaAction } from '@graasp/sdk';

import { resolveDependency } from '../../../../di/utils';
import { notUndefined } from '../../../../utils/assertions';
import { LOGIN_TOKEN_EXPIRATION_IN_MINUTES, PUBLIC_URL } from '../../../../utils/config';
import { buildRepositories } from '../../../../utils/repositories';
import { ActionService } from '../../../action/services/action';
import { getRedirectionUrl } from '../../utils';
import captchaPreHandler from '../captcha';
import {
  SHORT_TOKEN_PARAM,
  authenticatePassword,
  authenticatePasswordReset,
  isAuthenticated,
} from '../passport';
import {
  getMembersCurrentPasswordStatus,
  passwordLogin,
  patchResetPasswordRequest,
  postResetPasswordRequest,
  setPassword,
  setPasswordNoUser,
  updatePassword,
} from './schemas';
import { MemberPasswordService } from './service';
import { MemberService } from '../../../member/service';

const REDIRECTION_URL_PARAM = 'url';
const AUTHENTICATION_FALLBACK_ROUTE = '/auth';

const plugin: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;
  const actionService = resolveDependency(ActionService);
  const memberService = resolveDependency(MemberService);
  const memberPasswordService = resolveDependency(MemberPasswordService);

  // login with password
  fastify.post<{
    Body: { email: string; password: string; captcha: string; url?: string };
  }>(
    '/login-password',
    {
      schema: passwordLogin,
      preHandler: [
        captchaPreHandler(RecaptchaAction.SignInWithPassword, {
          shouldFail: false,
        }),
        authenticatePassword,
      ],
    },
    async (request, reply) => {
      const { body, log, user } = request;
      const { url } = body;
      const member = notUndefined(user?.member);
      const token = memberPasswordService.generateToken(
        { sub: member.id },
        `${LOGIN_TOKEN_EXPIRATION_IN_MINUTES}m`,
      );
      const redirectionUrl = getRedirectionUrl(log, url);

      const target = new URL(AUTHENTICATION_FALLBACK_ROUTE, PUBLIC_URL);
      target.searchParams.set(SHORT_TOKEN_PARAM, token);
      target.searchParams.set(REDIRECTION_URL_PARAM, encodeURIComponent(redirectionUrl));
      const resource = target.toString();

      reply.status(StatusCodes.OK);
      return { resource };
    },
  );

  /**
   * Set a password for the authenticated member.
   * If a password alread exists it will return a 409 (Conflict) error.
   * @param password - The new password.
   * @returns 204 No Content if the request was successful.
   */
  fastify.post<{ Body: { password: string } }>(
    '/password',
    { schema: setPassword, preHandler: isAuthenticated },
    async ({ user, body: { password } }, reply) => {
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        await memberPasswordService.post(member, buildRepositories(manager), password);
        reply.status(StatusCodes.NO_CONTENT);
      });
    },
  );

    /**
   * Set a password for the authenticated member.
   * If a password alread exists it will return a 409 (Conflict) error.
   * @param password - The new password.
   * @returns 204 No Content if the request was successful.
   */
  fastify.post<{ Body: { email: string, password: string } }>(
    '/password/nouser',
    { schema: setPasswordNoUser },
    async ({ body: { email, password } }, reply) => {
      return db.transaction(async (manager) => {
        const member = await memberService.getByEmail(
          buildRepositories(manager), email
        );
        if(member){
          await memberService.validate(member.id, buildRepositories(manager));
          await memberPasswordService.post(member, buildRepositories(manager), password);
        }
        else{
          console.log(member);
          reply.status(StatusCodes.NOT_FOUND);
        }
        reply.status(StatusCodes.NO_CONTENT);
      });
    },
  );


  /**
   * Update the password of the authenticated member.
   * If the currentPassword does not match what is stored an error will be returned.
   * @param currentPassword - The current password of the user.
   * @param password - The new password.
   * @returns 204 No Content if the request was successful.
   */
  fastify.patch<{ Body: { currentPassword: string; password: string } }>(
    '/password',
    { schema: updatePassword, preHandler: isAuthenticated },
    async ({ user, body: { currentPassword, password } }, reply) => {
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        await memberPasswordService.patch(
          member,
          buildRepositories(manager),
          password,
          currentPassword,
        );
        reply.status(StatusCodes.NO_CONTENT);
      });
    },
  );

  /**
   * Create a reset password request.
   * This will send an email to the member in his langage with a link to reset the password.
   * The link targets a frontend route endpoint.
   * The link will be valid for 24h.
   * If the member does not exist, or does not have a password, the request will return success, to avoid leaking information.
   * If the captcha is invalid the request will fail.
   * @param email - Email of the member requesting the password reset link.
   * @param captcha - Recaptcha response token.
   * @returns 204 No Content if the request was successful.
   */
  fastify.post<{ Body: { email: string; captcha: string } }>(
    '/password/reset',
    {
      schema: postResetPasswordRequest,
      preHandler: captchaPreHandler(RecaptchaAction.ResetPassword),
    },
    async (request, reply) => {
      const { email } = request.body;

      // We can already return to avoid leaking timing information.
      reply.status(StatusCodes.NO_CONTENT);
      reply.send();

      const repositories = buildRepositories();

      const resetPasswordRequest = await memberPasswordService.createResetPasswordRequest(
        repositories,
        email,
      );
      if (resetPasswordRequest) {
        const { token, member } = resetPasswordRequest;
        memberPasswordService.mailResetPasswordRequest(email, token, member.lang);
        const action = {
          member,
          type: ActionTriggers.AskResetPassword,
          view: Context.Auth,
          extra: {},
        };
        // Do not await the action to be saved. It is not critical.
        actionService.postMany(member, repositories, request, [action]);
      }
    },
  );

  /**
   * Solve the reset password request.
   * This will force the password to be updated.
   * A special token is required to perform this action. This token is sent by email to the member after creating a reset password request.
   * If the password is not strong enough, the request will fail with an error 400 Bad Request.
   * @param password - New password.
   * @returns 204 No Content if the request was successful.
   */
  fastify.patch<{ Body: { password: string }; User: { uuid: string } }>(
    '/password/reset',
    {
      schema: patchResetPasswordRequest,
      preHandler: authenticatePasswordReset,
    },
    async (request, reply) => {
      const repositories = buildRepositories();
      const {
        user,
        body: { password },
      } = request;
      const uuid = notUndefined(user?.passwordResetRedisKey);
      await memberPasswordService.applyReset(repositories, password, uuid);
      const member = await memberPasswordService.getMemberByPasswordResetUuid(repositories, uuid);
      reply.status(StatusCodes.NO_CONTENT);

      // Log the action
      const action = {
        member,
        type: ActionTriggers.ResetPassword,
        view: Context.Auth,
        extra: {},
      };
      // Do not await the action to be saved. It is not critical.
      actionService.postMany(member, repositories, request, [action]);
    },
  );

  /**
   * Get a boolean indicating if the authenticated member has a password.
   */
  fastify.get(
    '/members/current/password/status',
    {
      schema: getMembersCurrentPasswordStatus,
      preHandler: [isAuthenticated],
    },
    async ({ user }) => {
      const member = notUndefined(user?.member);
      const repositories = buildRepositories();
      const hasPassword = await memberPasswordService.hasPassword(repositories, member.id);
      return { hasPassword };
    },
  );
};

export default plugin;
