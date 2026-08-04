import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const emails = [
    'admin@tradew-setup.com',
    'admin@tradew-setp.com',
    'vivek.sannidhi29@gmail.com',
    'founder@tradew.local',
  ];

  const rawPassword = 'Password291102!';
  const passwordHash = await (bcrypt.hash ? bcrypt.hash(rawPassword, 10) : (bcrypt as any).default.hash(rawPassword, 10));

  for (const email of emails) {
    await prisma.user.upsert({
      where: { email },
      update: { isAdmin: true },
      create: {
        email,
        passwordHash,
        isAdmin: true,
      },
    });
    console.log(`Granted admin privileges to: ${email}`);
  }

  // Also set isAdmin = true for ALL users currently in DB
  const updatedAll = await prisma.user.updateMany({
    data: { isAdmin: true },
  });
  console.log(`Updated ${updatedAll.count} total user(s) to isAdmin=true.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
