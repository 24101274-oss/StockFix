import type { Role, User } from './types';

export interface ManagedUser extends User { active: boolean }
export interface CreateUserInput { name: string; email: string; role: Role; password: string; active?: boolean }
export interface UpdateUserInput { name: string; email: string; role: Role; active: boolean }
export interface ChangeUserPasswordInput { password: string }
export interface UserManagementResult { user: ManagedUser; sessionsRevoked: boolean; selfSessionRevoked: boolean }
