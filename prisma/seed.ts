import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: {
      name: 'ADMIN',
      description: 'System administrator with full access',
    },
  });

  const moderatorRole = await prisma.role.upsert({
    where: { name: 'MODERATOR' },
    update: {},
    create: {
      name: 'MODERATOR',
      description: 'Content moderator with limited admin access',
    },
  });

  const userRole = await prisma.role.upsert({
    where: { name: 'USER' },
    update: {},
    create: {
      name: 'USER',
      description: 'Regular user with basic permissions',
    },
  });

  // Create default permissions
  const permissions = [
    // User management
    { name: 'create_user', resource: 'user', action: 'create', roleName: 'ADMIN' },
    { name: 'read_user', resource: 'user', action: 'read', roleName: 'ADMIN' },
    { name: 'update_user', resource: 'user', action: 'update', roleName: 'ADMIN' },
    { name: 'delete_user', resource: 'user', action: 'delete', roleName: 'ADMIN' },

    // Article management
    { name: 'create_article', resource: 'article', action: 'create', roleName: 'ADMIN' },
    { name: 'read_article', resource: 'article', action: 'read', roleName: 'ADMIN' },
    { name: 'update_article', resource: 'article', action: 'update', roleName: 'ADMIN' },
    { name: 'delete_article', resource: 'article', action: 'delete', roleName: 'ADMIN' },
    { name: 'review_article', resource: 'article', action: 'review', roleName: 'MODERATOR' },

    // Chat management
    { name: 'create_room', resource: 'chat_room', action: 'create', roleName: 'ADMIN' },
    { name: 'read_room', resource: 'chat_room', action: 'read', roleName: 'ADMIN' },
    { name: 'update_room', resource: 'chat_room', action: 'update', roleName: 'ADMIN' },
    { name: 'delete_room', resource: 'chat_room', action: 'delete', roleName: 'ADMIN' },
    { name: 'manage_members', resource: 'room_member', action: 'manage', roleName: 'ADMIN' },
    { name: 'manage_messages', resource: 'message', action: 'manage', roleName: 'ADMIN' },
  ];

  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: {
        resource_action: {
          resource: permission.resource,
          action: permission.action,
        },
      },
      update: {},
      create: {
        name: permission.name,
        resource: permission.resource,
        action: permission.action,
        role: {
          connect: { name: permission.roleName },
        },
      },
    });
  }

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@example.com',
      passwordHash: adminPassword,
      role: {
        connect: { name: 'ADMIN' },
      },
      // roleId is removed as it is not assignable
      status: 'ACTIVE',
    },
  });

  // Create moderator user
  const moderatorPassword = await bcrypt.hash('mod123', 10);
  const moderator = await prisma.adminUser.upsert({
    where: { email: 'moderator@example.com' },
    update: {},
    create: {
      username: 'moderator',
      email: 'moderator@example.com',
      passwordHash: moderatorPassword,
      role: {
        connect: { name: 'MODERATOR' },
      },
      status: 'ACTIVE',
    },
  });

  // Create regular user
  const userPassword = await bcrypt.hash('user123', 10);
  const user = await prisma.adminUser.upsert({
    where: { email: 'user@example.com' },
    update: {},
    create: {
      username: 'user',
      email: 'user@example.com',
      passwordHash: userPassword,
      role: {
        connect: { name: 'USER' },
      },
      status: 'ACTIVE',
    },
  });

  console.log('✅ Database seeded successfully!');
  console.log('Admin user: admin@example.com / admin123');
  console.log('Moderator user: moderator@example.com / mod123');
  console.log('Regular user: user@example.com / user123');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });