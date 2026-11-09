const main = async (): Promise<void> => {
  console.log(`bhyve-conductor running on Node ${process.version}`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
