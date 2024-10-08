import { saveMember } from '../../../../../member/test/fixtures/members';
import { MemberPassword } from '../../entities/password';

export const MOCK_PASSWORD = {
  password: 'Passw0rd!',
  hashed: '$2b$10$H7l3yqcr26EtHjkC/ryaWOI30eiT6RoPXyb1cwglqdL4dIkE38G.6',
};

export const saveMemberAndPassword = async (member, { hashed }) => {
  const m = await saveMember(member);
  await MemberPassword.save({ member: m, password: hashed });
  return m;
};
