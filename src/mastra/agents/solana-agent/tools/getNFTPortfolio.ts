import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";

const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY";

// Manual mapping for well-known collections when API fails
const KNOWN_COLLECTION_MAPPINGS: Record<string, string> = {
  // DeGods
  'HZ4sRKiMPYh67n8fAjmHCnGnwhZfiKgXo1xJM6kNozZ8': 'degods',
  // y00ts  
  'FJTYE1VNxcn5U563DjAxrhZvGBN8KBcKHDWBwGbRQT7T': 'y00ts',
  // Add more as needed
};

// Collection name to slug mapping
const COLLECTION_NAME_TO_SLUG: Record<string, string> = {
  'degods': 'degods',
  'y00ts': 'y00ts', 
  'claynosaurz': 'claynosaurz',
  'okay bears': 'okay_bears',
  'solana monkey business': 'solana_monkey_business',
  'degenerate ape academy': 'degenerate_ape_academy',
  'famous fox federation': 'famous_fox_federation',
  'thugbirdz': 'thugbirdz',
  'aurory': 'aurory',
  'shadowy super coder': 'shadowy_super_coder',
  'solpunks': 'solpunks',
  'galactic geckos': 'galactic_geckos',
  'degen fat cats': 'degenfatcats',
  'bodoggos': 'bodoggos',
  'raccs': 'raccsnft',
  'taiyo pilots': 'taiyopilots',
  'whale riders': 'whale_riders',
  'snipies': 'snipies',
  'rarikeys': 'rarikeys',
  'the lowlifes': 'the_lowlifes',
  'shadow': 'shadow__',
  'sol arena': 'sol_arena_challengers',
  'crypto cavemen club': 'crypto_cavemen_club',
};

interface CollectionStats {
  floorPrice?: number;
  listedCount?: number;
  avgPrice24hr?: number;
  volumeAll?: number;
}

interface MagicEdenTokenResponse {
  collection?: string;
  collectionName?: string;
}

// Helper function to extract wallet address from various input formats
function extractWalletAddress(args: any): string | null {
  // Direct wallet address properties
  let walletAddress =
    args?.input?.walletAddress ||
    args?.walletAddress ||
    args?.context?.walletAddress ||
    null;

  // If args is a string, use it directly
  if (typeof args === "string") {
    walletAddress = args;
  }

  // Search for wallet address in input text/string
  if (!walletAddress && args?.input) {
    const inputStr = typeof args.input === "string" ? args.input : JSON.stringify(args.input);
    // Solana wallet addresses are 32-44 characters, base58 encoded
    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const matches = inputStr.match(solanaAddressRegex);

    if (matches) {
      // Take the longest match (most likely to be a complete address)
      walletAddress = matches.reduce((longest, current) =>
        current.length > longest.length ? current : longest, ""
      );
    }
  }

  // Clean up the wallet address
  if (walletAddress && typeof walletAddress === "string") {
    walletAddress = walletAddress.replace(/['"]/g, "").trim();
    // Validate length (Solana addresses are typically 32-44 characters)
    if (walletAddress.length >= 32 && walletAddress.length <= 44) {
      return walletAddress;
    }
  }

  return null;
}

// Get Magic Eden collection slug from NFT mint
async function getMagicEdenCollectionSlug(nftMint: string): Promise<string | null> {
  // Check manual mapping first
  if (KNOWN_COLLECTION_MAPPINGS[nftMint]) {
    console.log(`Using manual mapping for ${nftMint}: ${KNOWN_COLLECTION_MAPPINGS[nftMint]}`);
    return KNOWN_COLLECTION_MAPPINGS[nftMint];
  }
  
  try {
    console.log(`Attempting to get collection slug for NFT: ${nftMint}`);
    
    // Method 1: Try the token endpoint
    const response = await axios.get(`https://api-mainnet.magiceden.dev/v2/tokens/${nftMint}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NFT-Portfolio-Tool/1.0)',
        'Accept': 'application/json',
      }
    });
    
    console.log(`Magic Eden response for ${nftMint}:`, JSON.stringify(response.data, null, 2));
    
    // Try multiple possible fields for collection slug
    const collectionSlug = response.data?.collection || 
                          response.data?.collectionSymbol || 
                          response.data?.collectionName?.toLowerCase().replace(/\s+/g, '_') ||
                          null;
    
    if (collectionSlug) {
      console.log(`Found collection slug: ${collectionSlug}`);
      return collectionSlug;
    } else {
      console.log(`No collection slug found in response for ${nftMint}`);
    }
    
    // Method 2: Try alternative endpoint if first method fails
    console.log(`Trying alternative method for ${nftMint}`);
    const altResponse = await axios.get(`https://api-mainnet.magiceden.dev/v2/tokens/${nftMint}/activities`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NFT-Portfolio-Tool/1.0)',
        'Accept': 'application/json',
      }
    });
    
    // Check if activities contain collection info
    const activities = altResponse.data || [];
    if (activities.length > 0 && activities[0].collection) {
      console.log(`Found collection slug from activities: ${activities[0].collection}`);
      return activities[0].collection;
    }
    
    return null;
  } catch (error) {
    console.log(`Failed to get collection slug for ${nftMint}:`, error.response?.status, error.response?.data || error.message);
    return null;
  }
}

// Get collection stats from Magic Eden using collection slug
async function getCollectionStatsFromSlug(collectionSlug: string): Promise<CollectionStats> {
  try {
    const response = await axios.get(`https://api-mainnet.magiceden.dev/v2/collections/${collectionSlug}/stats`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NFT-Portfolio-Tool/1.0)',
      }
    });
    
    if (response.data?.floorPrice) {
      return {
        floorPrice: response.data.floorPrice / 1e9, // Convert lamports to SOL
        listedCount: response.data.listedCount,
        avgPrice24hr: response.data.avgPrice24hr ? response.data.avgPrice24hr / 1e9 : undefined,
        volumeAll: response.data.volumeAll ? response.data.volumeAll / 1e9 : undefined,
      };
    }
  } catch (error) {
    console.log(`Failed to get stats for collection ${collectionSlug}:`, error.message);
  }

  return {};
}

export const getNFTPortfolio = createTool({
  id: "getNFTPortfolio",
  description: "Get a Solana wallet's NFT collection with floor prices and collection stats. Shows only regular NFTs (no cNFTs or SPL tokens).",
  inputSchema: z.object({
    walletAddress: z.string().min(32).describe("Solana wallet address"),
  }),
  outputSchema: z.object({
    collections: z.array(
      z.object({
        name: z.string(),
        symbol: z.string().optional(),
        count: z.number(),
        floorPrice: z.number().optional(),
        estimatedValue: z.number().optional(),
        listedCount: z.number().optional(),
        nfts: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            symbol: z.string().optional(),
            description: z.string().optional(),
            image: z.string().optional(),
            externalUrl: z.string().optional(),
          })
        ),
      })
    ),
    totalNFTs: z.number(),
    totalCollections: z.number(),
    estimatedPortfolioValue: z.number(),
    text: z.string(),
  }),
  execute: async (args) => {
    // Use the robust wallet extraction helper
    const walletAddress = extractWalletAddress(args);

    if (!walletAddress) {
      throw new Error("walletAddress is required and must be a valid Solana address (32-44 characters)");
    }

    try {
      // Fetch only NFTs to reduce initial load
      const heliusRes = await axios.post(
        HELIUS_RPC,
        {
          jsonrpc: "2.0",
          id: "1",
          method: "searchAssets",
          params: {
            ownerAddress: walletAddress,
            tokenType: "nonFungible", // Only NFTs, no SPL tokens
            displayOptions: {
              showNativeBalance: false,
              showInscription: false,
              showCollectionMetadata: true,
            },
            limit: 1000, // Add limit to prevent massive responses
          },
        },
        { 
          headers: { "Content-Type": "application/json" },
          timeout: 30000, // 30 second timeout
        }
      );

      const items = heliusRes.data?.result?.items || [];

      console.log(`Total items from Helius: ${items.length}`);
      
      // IMMEDIATE FILTERING: Remove Lucky Emmy NFTs first to reduce processing load
      const withoutLuckyEmmy = items.filter((item: any) => {
        const nftName = item.content?.metadata?.name || '';
        const isLuckyEmmy = nftName.toLowerCase().includes('lucky emmy');
        if (isLuckyEmmy) {
          console.log(`Filtered out Lucky Emmy: ${nftName}`);
        }
        return !isLuckyEmmy;
      });
      
      console.log(`After Lucky Emmy filter: ${withoutLuckyEmmy.length} items (removed ${items.length - withoutLuckyEmmy.length} Lucky Emmy NFTs)`);
      
      // SECONDARY FILTERING: Apply quality filters to remaining items
      const regularNFTs = withoutLuckyEmmy.filter((item: any) => {
        const nftName = item.content?.metadata?.name || '';
        
        // Has NFT-like metadata (name, image, or collection info)
        const hasNFTMetadata = item.content?.metadata?.name || 
                              item.content?.links?.image ||
                              item.grouping?.length > 0;
        
        // Valid NFT interfaces - NOW INCLUDING Custom for y00ts and other legitimate NFTs
        const validInterface = item.interface === "V1_NFT" || 
                              item.interface === "ProgrammableNFT" ||
                              item.interface === "MplCoreAsset" ||
                              item.interface === "Custom";
        
        // Not compressed NFTs (cNFTs are usually spam/airdrops)
        const notCompressedSpam = !item.compression?.compressed;
        
        // Filter out obvious spam patterns
        const notSpam = !nftName.toLowerCase().includes('airdrop') &&
                       !nftName.toLowerCase().includes('free mint') &&
                       !nftName.toLowerCase().includes('claim');
        
        const isValid = hasNFTMetadata && 
                       validInterface && 
                       notCompressedSpam && 
                       notSpam;
        
        // Log filtered items for debugging
        if (!isValid) {
          const reason = !hasNFTMetadata ? 'No metadata' :
                        !validInterface ? `Invalid interface: ${item.interface}` :
                        !notCompressedSpam ? 'Compressed NFT' :
                        !notSpam ? 'Spam pattern detected' : 'Unknown';
          console.log(`Filtered out: ${nftName || item.id} - Reason: ${reason}`);
        } else if (item.interface === "Custom") {
          console.log(`Including Custom NFT: ${nftName} (${item.id})`);
        }
        
        return isValid;
      });

      console.log(`Found ${regularNFTs.length} NFTs out of ${items.length} total items`);

      // Process NFTs with essential data only
      const processedNFTs = regularNFTs.map((nft: any) => {
        const metadata = nft.content?.metadata || {};
        const links = nft.content?.links || {};
        const collectionInfo = nft.grouping?.[0] || {};
        
        return {
          id: nft.id,
          name: metadata.name || "Unnamed NFT",
          symbol: metadata.symbol || "",
          description: metadata.description || "",
          image: links.image || "",
          externalUrl: links.external_url || "",
          collectionName: collectionInfo.collection_metadata?.name || "Uncategorized",
          collectionSymbol: collectionInfo.collection_metadata?.symbol || "",
        };
      });

      // Group by collection name (not symbol, as that can be empty)
      const collectionMap = new Map();
      processedNFTs.forEach(nft => {
        const key = nft.collectionName;
        if (!collectionMap.has(key)) {
          collectionMap.set(key, {
            name: nft.collectionName,
            symbol: nft.collectionSymbol,
            nfts: [],
            collectionSlug: null, // Will be populated later
          });
        }
        collectionMap.get(key).nfts.push({
          id: nft.id,
          name: nft.name,
          symbol: nft.symbol,
          description: nft.description,
          image: nft.image,
          externalUrl: nft.externalUrl,
        });
      });

      console.log(`Grouped into ${collectionMap.size} collections`);

      // For each collection, get the Magic Eden collection slug from the first NFT
      const collections = [];
      let totalEstimatedValue = 0;

      for (const [collectionName, collectionData] of collectionMap) {
        const count = collectionData.nfts.length;
        let stats: CollectionStats = {};
        
        // Get Magic Eden collection slug from the first NFT in this collection
        if (collectionData.nfts.length > 0) {
          const firstNftMint = collectionData.nfts[0].id;
          console.log(`Getting collection slug for ${collectionName} using NFT ${firstNftMint}`);
          
          let collectionSlug = await getMagicEdenCollectionSlug(firstNftMint);
          
          // If API fails, try to derive from collection name
          if (!collectionSlug && collectionName) {
            const normalizedName = collectionName.toLowerCase().trim();
            collectionSlug = COLLECTION_NAME_TO_SLUG[normalizedName] || 
                           normalizedName.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
            console.log(`Derived collection slug from name "${collectionName}": ${collectionSlug}`);
          }
          
          if (collectionSlug) {
            console.log(`Found collection slug: ${collectionSlug}`);
            stats = await getCollectionStatsFromSlug(collectionSlug);
          } else {
            console.log(`No collection slug found for ${collectionName}`);
          }
        }

        const floorPrice = stats.floorPrice;
        const estimatedValue = floorPrice ? floorPrice * count : 0;
        
        if (estimatedValue > 0) {
          totalEstimatedValue += estimatedValue;
        }

        collections.push({
          name: collectionName,
          symbol: collectionData.symbol,
          count,
          floorPrice,
          estimatedValue: estimatedValue > 0 ? estimatedValue : undefined,
          listedCount: stats.listedCount,
          nfts: collectionData.nfts.slice(0, 5), // Limit to 5 NFTs per collection for display
        });
      }

      // Sort collections by estimated value (highest first), then by count
      collections.sort((a, b) => {
        const aValue = a.estimatedValue || 0;
        const bValue = b.estimatedValue || 0;
        if (aValue !== bValue) return bValue - aValue;
        return b.count - a.count;
      });

      // FIXED: Use correct counts
      const totalNFTs = regularNFTs.length;
      const totalCollections = collections.length;

      // Create summary text
      let text = `Here is the NFT portfolio for wallet \`${walletAddress}\`:\n\n`;
      
      if (collections.length === 0) {
        text += "🎨 **No regular NFTs found in this wallet.**\n\n";
        text += "This wallet either has no NFTs, or only contains compressed NFTs (cNFTs) which are typically spam/airdrops.";
      } else {
        text += `🎨 **NFT Portfolio Summary**\n\n`;
        text += `**Total Collections:** ${totalCollections}\n`;
        text += `**Total NFTs:** ${totalNFTs}\n`;
        if (totalEstimatedValue > 0) {
          text += `**Estimated Portfolio Value:** ${totalEstimatedValue.toFixed(2)} SOL\n`;
        }
        text += `\n---\n\n`;

        collections.forEach((collection, index) => {
          text += `### ${index + 1}. 📁 ${collection.name}\n`;
          text += `**Count:** ${collection.count} NFT${collection.count > 1 ? 's' : ''}\n`;
          
          if (collection.floorPrice) {
            text += `**Floor Price:** ${collection.floorPrice.toFixed(3)} SOL\n`;
          } else {
            text += `**Floor Price:** Not available\n`;
          }
          
          if (collection.estimatedValue) {
            text += `**Estimated Value:** ${collection.estimatedValue.toFixed(2)} SOL\n`;
          }
          
          if (collection.listedCount !== undefined) {
            text += `**Listed:** ${collection.listedCount} items\n`;
          }

          // Show sample NFTs
          text += `\n**Sample NFTs:**\n`;
          collection.nfts.slice(0, 3).forEach((nft, nftIndex) => {
            text += `${nftIndex + 1}. **${nft.name}**\n`;
            if (nft.description && nft.description.length < 80) {
              text += `   *${nft.description}*\n`;
            }
            text += `   ID: \`${nft.id}\`\n`;
          });

          if (collection.nfts.length > 3) {
            text += `   *...and ${collection.nfts.length - 3} more*\n`;
          }

          text += `\n`;
        });

        text += `\n💡 **Note:** Floor prices are fetched from Magic Eden using the proper token→collection→stats flow. Values are estimates based on current floor prices.`;
      }

      return {
        collections,
        totalNFTs,
        totalCollections,
        estimatedPortfolioValue: totalEstimatedValue,
        text,
      };

    } catch (error: any) {
      return {
        collections: [],
        totalNFTs: 0,
        totalCollections: 0,
        estimatedPortfolioValue: 0,
        text: `Error fetching NFT portfolio: ${error?.response?.data?.error || error.message || "Unable to fetch NFT data"}`,
      };
    }
  },
});